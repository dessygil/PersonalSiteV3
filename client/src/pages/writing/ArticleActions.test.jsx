import React from "react";
import { act, fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import "@testing-library/jest-dom";
import ArticleActions from "./ArticleActions";

const article = { slug: "a-useful-article", title: "A useful article", sourceUrl: "https://dev.to/author/original" };
const visitor = "4d92ca03-86c2-426b-8903-b7b037f4bd0e";
const storedVisitorKey = "des-site-reaction-visitor";
const response = (count = 3, liked = false) => ({ ok: true, json: async () => ({ count, liked }) });
const originalFetch = global.fetch;
const navigatorDescriptors = Object.fromEntries(["clipboard", "share", "canShare"].map(key => [key, Object.getOwnPropertyDescriptor(navigator, key)]));
function capability(key, value) { Object.defineProperty(navigator, key, { configurable: true, value }); }
function show(item = article) { return render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><ArticleActions key={item.slug} article={item} /></MemoryRouter>); }
const helpful = () => screen.getByRole("button", { name: /^Helpful/ });
const websiteUrl = () => new URL(`/writing/${article.slug}`, window.location.origin).href;
beforeEach(() => {
  window.localStorage.clear(); window.localStorage.setItem(storedVisitorKey, visitor);
  global.fetch = jest.fn(async () => response());
  capability("clipboard", { writeText: jest.fn(async () => {}) }); capability("share", undefined); capability("canShare", undefined);
});
afterEach(() => { cleanup(); jest.restoreAllMocks(); jest.useRealTimers(); });
afterAll(() => {
  global.fetch = originalFetch;
  Object.entries(navigatorDescriptors).forEach(([key, descriptor]) => { if (descriptor) Object.defineProperty(navigator, key, descriptor); else delete navigator[key]; });
});

test("loads the saved reaction, then confirms a helpful mark and its undo with the same browser identity", async () => {
  fetch.mockImplementation(async (url, options) => options.method === "POST" ? response(JSON.parse(options.body).liked ? 4 : 3, JSON.parse(options.body).liked) : response());
  const user = userEvent.setup(); show();
  expect(helpful()).toBeDisabled();
  await screen.findByText("3 helpful marks");
  expect(fetch.mock.calls[0][0]).toBe(`/api/article-reactions/${article.slug}?visitor=${visitor}`);
  expect(helpful()).toHaveAttribute("aria-pressed", "false");
  await user.click(helpful()); await screen.findByText("4 helpful marks");
  expect(helpful()).toHaveAttribute("aria-pressed", "true");
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ visitor, liked: true });
  await user.click(helpful()); await screen.findByText("3 helpful marks");
  expect(helpful()).toHaveAttribute("aria-pressed", "false");
  expect(JSON.parse(fetch.mock.calls[2][1].body)).toEqual({ visitor, liked: false });
  expect(screen.getByText("Your helpful mark has been removed.")).toBeInTheDocument();
});

test("a failed save keeps the confirmed count and retries the same intended update", async () => {
  let failRequest;
  fetch.mockResolvedValueOnce(response()).mockImplementationOnce(() => new Promise((resolve, reject) => { failRequest = reject; })).mockResolvedValueOnce(response(4, true));
  show(); await screen.findByText("3 helpful marks");
  fireEvent.click(helpful());
  expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Saving…" }));
  expect(fetch).toHaveBeenCalledTimes(2);
  await act(async () => failRequest(new Error("Offline")));
  expect(screen.getByText(/Your update could not be confirmed/)).toBeInTheDocument();
  expect(screen.getByText("3 helpful marks")).toBeInTheDocument();
  expect(helpful()).toHaveAttribute("aria-pressed", "false");
  fireEvent.click(screen.getByRole("button", { name: "Retry saving helpful mark" }));
  await screen.findByText("4 helpful marks");
  expect(fetch.mock.calls.slice(1).map(([, options]) => JSON.parse(options.body).liked)).toEqual([true, true]);
});

test.each([
  { ok: false, json: async () => ({ count: 4, liked: true }) },
  { ok: true, json: async () => ({ count: "4", liked: true }) },
  { ok: true, json: async () => ({ count: 3, liked: false }) },
])("does not claim persistence when the update response is rejected or unconfirmed", async result => {
  fetch.mockResolvedValueOnce(response()).mockResolvedValueOnce(result);
  show(); await screen.findByText("3 helpful marks"); fireEvent.click(helpful());
  await screen.findByText(/Your update could not be confirmed/);
  expect(helpful()).toHaveAttribute("aria-pressed", "false"); expect(screen.getByText("3 helpful marks")).toBeInTheDocument();
});

test("failed count loads are retryable and do not present a fabricated zero", async () => {
  fetch.mockRejectedValueOnce(new Error("Offline")).mockResolvedValueOnce(response(1, true));
  show(); await screen.findByText("Count unavailable"); expect(helpful()).toBeDisabled();
  expect(screen.queryByText("0 helpful marks")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retry loading helpful count" }));
  await screen.findByText("1 helpful mark"); expect(helpful()).toHaveAttribute("aria-pressed", "true");
});

test("a reaction timeout cancels the request and leaves the last confirmed state", async () => {
  jest.useFakeTimers(); show(); await screen.findByText("3 helpful marks");
  fetch.mockImplementationOnce((_, options) => new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("Aborted")))));
  fireEvent.click(helpful()); await act(async () => jest.advanceTimersByTime(10000));
  expect(fetch.mock.calls[1][1].signal.aborted).toBe(true);
  expect(screen.getByText(/Your update could not be confirmed/)).toBeInTheDocument();
  expect(helpful()).toHaveAttribute("aria-pressed", "false");
});

test("blocked storage falls back to a stable in-memory UUID without requiring an account", async () => {
  jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
  jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
  const first = show(); await screen.findByText("3 helpful marks");
  const firstId = new URL(fetch.mock.calls[0][0], window.location.origin).searchParams.get("visitor");
  expect(firstId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i);
  first.unmount(); show(); await screen.findByText("3 helpful marks");
  expect(new URL(fetch.mock.calls[1][0], window.location.origin).searchParams.get("visitor")).toBe(firstId);
});

test("copy, LinkedIn and question links use the website URL and correct contact anchor", async () => {
  show(); fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
  await screen.findByText("Link copied."); expect(navigator.clipboard.writeText).toHaveBeenCalledWith(websiteUrl());
  const linkedIn = new URL(screen.getByRole("link", { name: "Share on LinkedIn" }).href);
  expect(linkedIn.origin).toBe("https://www.linkedin.com"); expect(linkedIn.searchParams.get("url")).toBe(websiteUrl());
  expect(screen.getByRole("link", { name: "Ask me about this article" })).toHaveAttribute("href", `/?article=${article.slug}#Contact-anchor`);
  expect(screen.queryByRole("button", { name: "Share…" })).not.toBeInTheDocument();
});

test("a blocked clipboard offers a selected, accessible manual copy field without claiming success", async () => {
  navigator.clipboard.writeText.mockRejectedValue(new Error("Blocked")); show();
  fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
  const field = await screen.findByRole("textbox", { name: "Article link" });
  expect(field).toHaveValue(websiteUrl()); expect(field).toHaveFocus(); expect(field.selectionEnd).toBe(websiteUrl().length);
  expect(screen.queryByText("Link copied.")).not.toBeInTheDocument();
});

test("native sharing appears only when supported and cancellation stays honest", async () => {
  capability("share", jest.fn().mockRejectedValue(Object.assign(new Error("Cancelled"), { name: "AbortError" })));
  capability("canShare", jest.fn(() => true)); show();
  fireEvent.click(await screen.findByRole("button", { name: "Share…" }));
  await screen.findByText("Sharing cancelled.");
  expect(navigator.share).toHaveBeenCalledWith({ title: article.title, url: websiteUrl() });
  expect(screen.queryByText("Share completed.")).not.toBeInTheDocument();
});

test("unsupported share data does not expose the native share control", async () => {
  capability("share", jest.fn()); capability("canShare", jest.fn(() => false)); show();
  await waitFor(() => expect(helpful()).toBeEnabled());
  expect(screen.queryByRole("button", { name: "Share…" })).not.toBeInTheDocument();
});
