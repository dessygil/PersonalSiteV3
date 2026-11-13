import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import Analytics from "./Analytics";
import { getSiteConfig } from "./siteConfig";
import { mountAnalytics } from "./siteAnalytics";

jest.mock("./siteConfig", () => ({ getSiteConfig: jest.fn() }));
jest.mock("./siteAnalytics", () => ({ mountAnalytics: jest.fn() }));

function Navigation() {
  const navigate = useNavigate();
  return <><button onClick={() => navigate("/writing?search=private@example.com#section")}>Filter</button><button onClick={() => navigate("/writing/test-post")}>Article</button></>;
}

test("React route integration tracks pathname changes and cleans up on disable or unmount", () => {
  const first = { page: jest.fn(), release: jest.fn() };
  const disabled = { page: jest.fn(), release: jest.fn() };
  getSiteConfig.mockReturnValue({ analytics: { enabled: true, endpoint: "/api/analytics" } });
  mountAnalytics.mockReturnValueOnce(first).mockReturnValue(disabled);
  const app = <MemoryRouter initialEntries={["/writing"]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><Analytics /><Navigation /></MemoryRouter>;
  const { rerender, unmount } = render(app);
  expect(first.page.mock.calls).toEqual([["/writing"]]);
  fireEvent.click(screen.getByRole("button", { name: "Filter" }));
  expect(first.page.mock.calls).toEqual([["/writing"]]);
  fireEvent.click(screen.getByRole("button", { name: "Article" }));
  expect(first.page.mock.calls).toEqual([["/writing"], ["/writing/test-post"]]);
  getSiteConfig.mockReturnValue({ analytics: { enabled: false, endpoint: "/api/analytics" } });
  rerender(<MemoryRouter initialEntries={["/writing"]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><Analytics /><Navigation /></MemoryRouter>);
  expect(first.release).toHaveBeenCalledTimes(1);
  expect(mountAnalytics).toHaveBeenLastCalledWith({ analytics: { enabled: false, endpoint: "/api/analytics" } });
  unmount();
  expect(disabled.release).toHaveBeenCalledTimes(1);
});
