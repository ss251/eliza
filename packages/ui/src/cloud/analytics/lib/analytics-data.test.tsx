/**
 * Analytics data hooks (`useAnalyticsBreakdown`, `useAnalyticsProjections`)
 * through the real auth gate and the real `api-client` transport: the suite
 * persists a session JWT, stubs only the network boundary, and asserts the
 * request URLs, session-scoped query keys, envelope unwrapping, and error
 * translation the hooks actually produce.
 */
// @vitest-environment jsdom

import type {
  AnalyticsTimeSeriesPointDto,
  EnhancedAnalyticsDataDto,
  ProjectionsDataDto,
} from "@elizaos/cloud-sdk";
import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../../lib/api-client";
import {
  useAnalyticsBreakdown,
  useAnalyticsProjections,
} from "./analytics-data";

function makeJwt(payload: Record<string, unknown>): string {
  const b64url = (value: object) =>
    btoa(JSON.stringify(value))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}.sig`;
}

const SESSION_JWT = makeJwt({
  userId: "u1",
  exp: Math.floor(Date.now() / 1000) + 600,
});

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => [...store.keys()][index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
  };
}

let storage: Storage;
const fetchMock =
  vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

function respondWith(payload: unknown, status = 200): void {
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

function seriesPoint(timestamp: string): AnalyticsTimeSeriesPointDto {
  return {
    timestamp,
    totalRequests: 10,
    totalCost: 0.3,
    inputTokens: 250,
    outputTokens: 500,
    successRate: 0.9,
    successRatePercent: 90,
  };
}

const BREAKDOWN_ENVELOPE_DATA: EnhancedAnalyticsDataDto = {
  filters: {
    startDate: "2026-08-17T00:00:00.000Z",
    endDate: "2026-08-24T00:00:00.000Z",
    granularity: "day",
    timeRange: "weekly",
  },
  overallStats: {
    totalRequests: 42,
    totalInputTokens: 1000,
    totalOutputTokens: 2000,
    totalCost: 1.25,
    successRate: 0.95,
  },
  timeSeriesData: [seriesPoint("2026-08-23T00:00:00.000Z")],
  userBreakdown: [
    {
      userId: "u1",
      userName: null,
      userEmail: "u1@example.test",
      totalRequests: 42,
      totalCost: 1.25,
      inputTokens: 1000,
      outputTokens: 2000,
      lastActive: "2026-08-23T12:00:00.000Z",
    },
  ],
  costTrending: {
    currentDailyBurn: 0.5,
    previousDailyBurn: 0.4,
    burnChangePercent: 25,
    projectedMonthlyBurn: 15,
    daysUntilBalanceZero: 30,
    monthlyBurnPercent: 50,
    monthlyBurnPercentClamped: 50,
    burnAlertThresholdExceeded: false,
  },
  organization: { creditBalance: "100" },
  providerBreakdown: [
    {
      provider: "openai",
      totalRequests: 42,
      totalCost: 1.25,
      totalTokens: 3000,
      successRate: 0.95,
      percentage: 100,
    },
  ],
  modelBreakdown: [
    {
      model: "gpt-4o",
      provider: "openai",
      totalRequests: 42,
      totalCost: 1.25,
      totalTokens: 3000,
      avgCostPerToken: 0.000417,
      successRate: 0.95,
    },
  ],
  trends: {
    requestsChange: 5,
    costChange: 10,
    tokensChange: 7,
    successRateChange: -1,
    period: "week",
  },
};

const PROJECTIONS_ENVELOPE_DATA: ProjectionsDataDto = {
  historicalData: [seriesPoint("2026-08-22T00:00:00.000Z")],
  projections: [
    {
      ...seriesPoint("2026-08-25T00:00:00.000Z"),
      isProjected: true,
      confidence: 0.8,
    },
  ],
  alerts: [
    {
      type: "warning",
      title: "Burn rate up",
      message: "Daily burn increased 25% week over week.",
    },
  ],
  creditBalance: 88.5,
};

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
}

function freshClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

/** The one analytics-domain query in the cache, for key assertions. */
function analyticsQueryKeys(client: QueryClient): unknown[][] {
  return client
    .getQueryCache()
    .getAll()
    .filter((query) => query.queryKey[0] === "analytics")
    .map((query) => [...query.queryKey]);
}

beforeEach(() => {
  storage = createMemoryStorage();
  storage.setItem(STEWARD_TOKEN_KEY, SESSION_JWT);
  vi.stubGlobal("localStorage", storage);
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage,
  });
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useAnalyticsBreakdown", () => {
  it("requests the breakdown endpoint for the default weekly range and unwraps the envelope data", async () => {
    respondWith({ success: true, data: BREAKDOWN_ENVELOPE_DATA });
    const client = freshClient();
    const { result } = renderHook(() => useAnalyticsBreakdown(), {
      wrapper: wrapper(client),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/analytics/breakdown?timeRange=weekly");
    expect(result.current.data).toEqual(BREAKDOWN_ENVELOPE_DATA);
    // The persisted steward JWT rides the real transport as the Bearer.
    expect(init ? new Headers(init.headers).get("authorization") : null).toBe(
      `Bearer ${SESSION_JWT}`,
    );
  });

  it("re-filters on an explicit time range and scopes the query key by session user id", async () => {
    respondWith({ success: true, data: BREAKDOWN_ENVELOPE_DATA });
    const client = freshClient();
    const { result } = renderHook(() => useAnalyticsBreakdown("daily"), {
      wrapper: wrapper(client),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/analytics/breakdown?timeRange=daily",
    );
    expect(analyticsQueryKeys(client)).toEqual([
      ["analytics", "breakdown", "daily", "auth", "u1"],
    ]);
  });

  it("stays idle and never fetches when no persisted session enables the gate", async () => {
    storage.removeItem(STEWARD_TOKEN_KEY);
    const client = freshClient();
    const { result } = renderHook(() => useAnalyticsBreakdown("monthly"), {
      wrapper: wrapper(client),
    });

    await waitFor(() => expect(result.current.fetchStatus).toBe("idle"));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(analyticsQueryKeys(client)).toEqual([
      ["analytics", "breakdown", "monthly", "auth", null],
    ]);
  });
});

describe("useAnalyticsProjections", () => {
  it("requests a 7-period horizon by default and exposes the unwrapped projection payload", async () => {
    respondWith({ success: true, data: PROJECTIONS_ENVELOPE_DATA });
    const client = freshClient();
    const { result } = renderHook(() => useAnalyticsProjections(), {
      wrapper: wrapper(client),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/analytics/projections?periods=7",
    );
    expect(result.current.data).toEqual(PROJECTIONS_ENVELOPE_DATA);
    expect(analyticsQueryKeys(client)).toEqual([
      ["analytics", "projections", 7, "auth", "u1"],
    ]);
  });

  it("reflects an explicit horizon in both the request and the query key", async () => {
    respondWith({ success: true, data: PROJECTIONS_ENVELOPE_DATA });
    const client = freshClient();
    const { result } = renderHook(() => useAnalyticsProjections(30), {
      wrapper: wrapper(client),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/analytics/projections?periods=30",
    );
    expect(analyticsQueryKeys(client)).toEqual([
      ["analytics", "projections", 30, "auth", "u1"],
    ]);
  });

  it("surfaces a failed response as an ApiError carrying the status", async () => {
    respondWith({ error: "boom" }, 500);
    const client = freshClient();
    const { result } = renderHook(() => useAnalyticsProjections(7), {
      wrapper: wrapper(client),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();

    const error = result.current.error;
    expect(error).toBeInstanceOf(ApiError);
    if (error instanceof ApiError) {
      expect(error.status).toBe(500);
      expect(error.code).toBe("HTTP_500");
      expect(error.message).toBe("boom");
    }
  });
});
