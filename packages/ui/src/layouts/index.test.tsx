/** Verifies the layouts barrel's exported layout contracts through the configured test harness. */
// @vitest-environment jsdom

/**
 * Verifies the consumer-visible behaviour behind src/layouts/index.ts by
 * rendering its exports the way `@elizaos/ui/layouts` consumers do:
 * WorkspaceLayout's inside/outside header placement, ref forwarding, content
 * padding and sidebar chrome defaults; ContentLayout's single-pane/modal
 * variants; and PageLayout's forced outside header. Real components against
 * jsdom; only the viewport media query is pinned.
 */

import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SidebarProps } from "../components/composites/sidebar";
import { ContentLayout, PageLayout, WorkspaceLayout } from "./index";

function pinViewport(desktop: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    // WorkspaceLayout gates desktop mode on "(min-width: 820px)"; every other
    // query (pointer/hover probes from primitives) reports no match.
    matches: desktop && query.includes("min-width: 820px"),
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

/**
 * Stand-in for any sidebar element: surfaces the props WorkspaceLayout merges
 * in via cloneElement (className override, collapsible/variant defaults) so the
 * merge itself can be asserted from the rendered DOM.
 */
function RecordingSidebar(props: {
  className?: string;
  collapsible?: boolean;
  variant?: string;
}) {
  return (
    <nav
      data-testid="recording-sidebar"
      className={props.className}
      data-collapsible={String(props.collapsible)}
      data-variant={props.variant ?? "unset"}
    >
      sidebar body
    </nav>
  );
}

const recordingSidebar = (
  <RecordingSidebar />
) as unknown as ReactElement<SidebarProps>;

function mainPane(): HTMLElement {
  const main = screen.getByTestId("subject").closest("main");
  expect(main).not.toBeNull();
  return main as HTMLElement;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("layouts barrel", () => {
  it("renders WorkspaceLayout children inside the main scroll region", () => {
    pinViewport(true);
    render(
      <WorkspaceLayout>
        <p data-testid="subject">body</p>
      </WorkspaceLayout>,
    );

    expect(mainPane().contains(screen.getByTestId("subject"))).toBe(true);
  });

  it("places a default content header above the main pane (outside placement)", () => {
    pinViewport(true);
    render(
      <WorkspaceLayout contentHeader={<h1>Shell Header</h1>}>
        <p data-testid="subject">body</p>
      </WorkspaceLayout>,
    );

    const heading = screen.getByRole("heading", { name: "Shell Header" });
    const main = mainPane();
    expect(
      within(main).queryByRole("heading", { name: "Shell Header" }),
    ).toBeNull();
    expect(
      heading.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('places headerPlacement="inside" headers inside main, above the content', () => {
    pinViewport(true);
    render(
      <WorkspaceLayout
        contentHeader={<h1>Inner Header</h1>}
        headerPlacement="inside"
      >
        <p data-testid="subject">body</p>
      </WorkspaceLayout>,
    );

    const heading = screen.getByRole("heading", { name: "Inner Header" });
    const main = mainPane();
    expect(within(main).getByRole("heading", { name: "Inner Header" })).toBe(
      heading,
    );
    expect(
      heading.compareDocumentPosition(screen.getByTestId("subject")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("forwards function refs to the main scroll container", () => {
    pinViewport(true);
    const box: { current: HTMLElement | null } = { current: null };
    render(
      <WorkspaceLayout
        contentRef={(node) => {
          box.current = node;
        }}
      >
        <p data-testid="subject">body</p>
      </WorkspaceLayout>,
    );

    expect(box.current?.tagName).toBe("MAIN");
    expect(box.current?.contains(screen.getByTestId("subject"))).toBe(true);
  });

  it("forwards object refs to the same main scroll container", () => {
    pinViewport(true);
    const ref = createRef<HTMLElement>();
    render(
      <WorkspaceLayout contentRef={ref}>
        <p data-testid="subject">body</p>
      </WorkspaceLayout>,
    );

    expect(ref.current?.tagName).toBe("MAIN");
  });

  it("applies content padding by default and drops it with contentPadding=false", () => {
    pinViewport(true);
    const padded = render(
      <WorkspaceLayout>
        <p data-testid="subject">body</p>
      </WorkspaceLayout>,
    );
    expect(mainPane().className).toContain("px-2");
    padded.unmount();

    render(
      <WorkspaceLayout contentPadding={false}>
        <p data-testid="subject">body</p>
      </WorkspaceLayout>,
    );
    expect(mainPane().className).not.toContain("px-2");
  });

  it("merges full-height chrome and defaults onto a provided desktop sidebar", () => {
    pinViewport(true);
    render(
      <WorkspaceLayout sidebar={recordingSidebar}>
        <p data-testid="subject">body</p>
      </WorkspaceLayout>,
    );

    const nav = screen.getByTestId("recording-sidebar");
    expect(nav.getAttribute("data-variant")).toBe("default");
    expect(nav.getAttribute("data-collapsible")).toBe("true");
    expect(nav.className).toContain("!h-full");
  });

  it("honours sidebarCollapsible=false for a sidebar without its own choice", () => {
    pinViewport(true);
    render(
      <WorkspaceLayout sidebar={recordingSidebar} sidebarCollapsible={false}>
        <p data-testid="subject">body</p>
      </WorkspaceLayout>,
    );

    expect(
      screen.getByTestId("recording-sidebar").getAttribute("data-collapsible"),
    ).toBe("false");
  });

  it("keeps ContentLayout's content header inside the scrollable column", () => {
    pinViewport(true);
    const { container } = render(
      <ContentLayout contentHeader={<h1>Column Header</h1>}>
        <p data-testid="subject">body</p>
      </ContentLayout>,
    );
    const shell = container.firstElementChild as HTMLElement;

    expect(shell.className).toContain("eliza-content-layout");
    expect(
      within(mainPane()).getByRole("heading", { name: "Column Header" }),
    ).not.toBeNull();
  });

  it("strips the shell marker and padding in modal embedding while keeping caller classes", () => {
    pinViewport(true);
    const { container } = render(
      <ContentLayout inModal className="modal-shell">
        <p data-testid="subject">body</p>
      </ContentLayout>,
    );
    const shell = container.firstElementChild as HTMLElement;

    expect(shell.className).toContain("modal-shell");
    expect(shell.className).not.toContain("eliza-content-layout");
    expect(mainPane().className).not.toContain("px-2");
  });

  it("forces PageLayout's header outside the main pane", () => {
    pinViewport(true);
    render(
      <PageLayout sidebar={recordingSidebar} contentHeader={<h1>Page Head</h1>}>
        <p data-testid="subject">body</p>
      </PageLayout>,
    );

    const heading = screen.getByRole("heading", { name: "Page Head" });
    const main = mainPane();
    expect(
      within(main).queryByRole("heading", { name: "Page Head" }),
    ).toBeNull();
    expect(
      heading.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
