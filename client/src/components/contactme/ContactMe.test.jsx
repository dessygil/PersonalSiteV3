import React from "react";
import { renderToStaticMarkup } from "react-dom/server.node";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import ContactMe, { articleQuestionMessage } from "./ContactMe";
import { trackContactSuccess } from "../../lib/siteAnalytics";
jest.mock("../../lib/siteAnalytics", () => ({ trackContactSuccess: jest.fn() }));
jest.mock("../../lib/writingData", () => [
  { slug: "runtime-protein-notes", title: "Protein stability & binding", sourceUrl: "https://dev.to/dessygil/runtime-protein-notes" },
  { slug: "runtime-coding-notes", title: "A coding notebook", sourceUrl: "https://dev.to/dessygil/runtime-coding-notes" },
]);
const configured = { contact: { endpoint: "/api/contact" } };
const originalLocation = Object.getOwnPropertyDescriptor(window, "location");
const originalFetch = global.fetch;
beforeAll(() => Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, assign: jest.fn() } }));
beforeEach(() => { global.fetch = jest.fn(); window.location.assign.mockReset(); window.location.search = ""; window.location.origin = "https://desmondgilmour.com"; trackContactSuccess.mockReset(); });
afterEach(() => jest.useRealTimers());
afterAll(() => { Object.defineProperty(window, "location", originalLocation); global.fetch = originalFetch; });
const values = { Name: "Alex Reader", Email: "alex@example.com", Message: "I enjoyed your article & would like to connect." };
function fill() { Object.entries(values).forEach(([label, value]) => fireEvent.change(screen.getByLabelText(label), { target: { value } })); }
function submit() { fireEvent.submit(screen.getByRole("form", { name: "Contact Desmond" })); }
function retained() { Object.entries(values).forEach(([label, value]) => expect(screen.getByLabelText(label)).toHaveValue(value)); }

test("invalid fields receive accessible descriptions and focus without sending a request", async () => {
  const user = userEvent.setup(); render(<ContactMe config={configured} />);
  await user.click(screen.getByRole("button", { name: "Send message" }));
  expect(screen.getByLabelText("Name")).toHaveFocus();
  expect(screen.getByLabelText("Name")).toHaveAttribute("aria-invalid", "true");
  expect(screen.getByLabelText("Name")).toHaveAccessibleDescription("Enter your name.");
  expect(screen.getByLabelText("Email")).toHaveAccessibleDescription("Enter a valid email address.");
  expect(screen.getByLabelText("Message")).toHaveAccessibleDescription("Add a message.");
  expect(screen.getByRole("alert")).toHaveTextContent("Please check");
  fill(); fireEvent.change(screen.getByLabelText("Email"), { target: { value: "not-an-email" } });
  await user.click(screen.getByRole("button", { name: "Send message" }));
  expect(screen.getByLabelText("Email")).toHaveFocus(); expect(fetch).not.toHaveBeenCalled();
});

test("pending requests resist duplicates; confirmed receipt clears fields and records no personal analytics data", async () => {
  let finish; fetch.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  render(<ContactMe config={configured} />);
  expect(screen.getByRole("form")).toHaveAttribute("action", "/api/contact");
  expect(screen.getByRole("form")).toHaveAttribute("method", "post");
  fill(); submit(); submit();
  expect(screen.getByRole("button", { name: "Submitting…" })).toBeDisabled();
  expect(screen.getByLabelText("Message")).toBeDisabled(); expect(fetch).toHaveBeenCalledTimes(1);
  const [url, request] = fetch.mock.calls[0]; expect(url).toBe("/api/contact");
  expect(request.headers.Accept).toBe("application/json"); expect(request.method).toBe("POST");
  expect(JSON.parse(request.body)).toEqual({ name: values.Name, email: values.Email, message: values.Message, _gotcha: "" });
  await act(async () => finish({ status: 202, json: async () => ({ ok: true }) }));
  expect(screen.getByRole("status")).toHaveTextContent("your message has been received");
  Object.keys(values).forEach(label => expect(screen.getByLabelText(label)).toHaveValue(""));
  expect(trackContactSuccess).toHaveBeenCalledTimes(1); expect(trackContactSuccess).toHaveBeenCalledWith();
});

test.each([
  ["server rejection", () => Promise.resolve({ status: 422, json: async () => ({ error: "Invalid" }) })],
  ["unconfirmed receipt", () => Promise.resolve({ status: 202, json: async () => ({ ok: false }) })],
  ["unexpected successful page", () => Promise.resolve({ status: 200, json: async () => ({ ok: true }) })],
  ["network failure", () => Promise.reject(new Error("Offline"))],
])("%s keeps the message and does not claim success", async (_, result) => {
  fetch.mockImplementation(result); render(<ContactMe config={configured} />); fill(); submit();
  expect(await screen.findByRole("alert")).toHaveTextContent("Receipt could not be confirmed"); retained();
  expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled(); expect(trackContactSuccess).not.toHaveBeenCalled();
});

test("timeout aborts a pending request without losing the message", async () => {
  jest.useFakeTimers();
  fetch.mockImplementation((_, options) => new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("Aborted")))));
  render(<ContactMe config={configured} />); fill(); submit();
  await act(async () => jest.advanceTimersByTime(15000));
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(true); expect(screen.getByRole("alert")).toHaveTextContent("request timed out"); retained();
  expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled(); expect(trackContactSuccess).not.toHaveBeenCalled();
});

test("unconfigured mode opens a populated email draft and never claims delivery", () => {
  render(<ContactMe config={{ contact: { endpoint: null } }} />);
  expect(screen.getByText(/This opens your email app with a draft/)).toBeInTheDocument(); fill();
  fireEvent.click(screen.getByRole("button", { name: "Open email draft" }));
  const mailto = new URL(window.location.assign.mock.calls[0][0]);
  expect(mailto.protocol).toBe("mailto:"); expect(mailto.pathname).toBe("desmondgilmour@gmail.com");
  expect(mailto.searchParams.get("subject")).toBe("Website message from Alex Reader");
  expect(mailto.searchParams.get("body")).toBe(`${values.Message}\n\nFrom: ${values.Name}\nReply to: ${values.Email}`);
  expect(screen.getByRole("status")).toHaveTextContent("nothing has been sent from this website"); retained();
  expect(fetch).not.toHaveBeenCalled(); expect(trackContactSuccess).not.toHaveBeenCalled();
  expect(screen.getByRole("link", { name: "Email me" })).toHaveAttribute("href", "mailto:desmondgilmour@gmail.com");
  expect(screen.getByRole("link", { name: "Connect on LinkedIn" })).toHaveAttribute("href", "https://www.linkedin.com/in/desmondgilmour");
});

test("an untrusted endpoint cannot receive contact details", () => {
  render(<ContactMe config={{ contact: { endpoint: "https://untrusted.example/contact" } }} />); fill();
  fireEvent.click(screen.getByRole("button", { name: "Open email draft" }));
  expect(fetch).not.toHaveBeenCalled(); expect(window.location.assign).toHaveBeenCalledWith(expect.stringMatching(/^mailto:/));
});

test("a filled honeypot is blocked without claiming receipt", () => {
  const { container } = render(<ContactMe config={configured} />); fill();
  fireEvent.change(container.querySelector('[name="_gotcha"]'), { target: { value: "spam" } }); submit();
  expect(fetch).not.toHaveBeenCalled(); expect(screen.getByRole("alert")).toHaveTextContent("form could not be submitted"); expect(trackContactSuccess).not.toHaveBeenCalled();
});

test("analytics failure cannot undo confirmed receipt", async () => {
  fetch.mockResolvedValue({ status: 202, json: async () => ({ ok: true }) });
  trackContactSuccess.mockImplementation(() => { throw new Error("Analytics unavailable"); });
  render(<ContactMe config={configured} />); fill(); submit();
  expect(await screen.findByText("Thanks — your message has been received.")).toBeInTheDocument(); expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("a blocked email app leaves guidance and keeps the draft", () => {
  window.location.assign.mockImplementation(() => { throw new Error("Blocked"); });
  render(<ContactMe config={{ contact: { endpoint: null } }} />); fill();
  fireEvent.click(screen.getByRole("button", { name: "Open email draft" }));
  expect(screen.getByRole("status")).toHaveTextContent("Nothing has been sent"); retained();
});

test("an article question uses the runtime title and live site URL without sending anything", () => {
  window.location.origin = "https://preview.example.test";
  window.location.search = "?article=runtime-protein-notes&title=Untrusted+title&url=https://untrusted.example";
  const { container } = render(<ContactMe config={configured} />);
  expect(screen.getByLabelText("Message")).toHaveValue('Hi Desmond,\n\nI have a question about your article "Protein stability & binding":\nhttps://preview.example.test/writing/runtime-protein-notes\n\n');
  expect(screen.getByLabelText("Name")).toHaveValue("");
  expect(screen.getByLabelText("Email")).toHaveValue("");
  expect(container.querySelector("#Contact-anchor")).toBeInTheDocument();
  expect(fetch).not.toHaveBeenCalled();
  expect(window.location.assign).not.toHaveBeenCalled();
  expect(trackContactSuccess).not.toHaveBeenCalled();
});

test.each(["", "?article=unknown-post", "?article=https%3A%2F%2Funtrusted.example%2Fpost", "?title=Anything&message=Untrusted+draft"])("unrecognized article input %s leaves the form blank", search => {
  window.location.search = search;
  render(<ContactMe config={configured} />);
  expect(screen.getByLabelText("Message")).toHaveValue("");
  expect(fetch).not.toHaveBeenCalled();
  expect(window.location.assign).not.toHaveBeenCalled();
});

test("rerenders and query changes preserve both an edited and a deliberately cleared draft", () => {
  window.location.search = "?article=runtime-protein-notes";
  const { rerender } = render(<ContactMe config={configured} />);
  fill();
  window.location.search = "?article=runtime-coding-notes";
  rerender(<ContactMe config={{ contact: { endpoint: null } }} />);
  retained();
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "" } });
  rerender(<ContactMe config={configured} />);
  expect(screen.getByLabelText("Message")).toHaveValue("");
  expect(fetch).not.toHaveBeenCalled();
  expect(window.location.assign).not.toHaveBeenCalled();
});

test("article-prefilled email mode opens a draft only after the visitor submits", () => {
  window.location.search = "?article=runtime-protein-notes";
  render(<ContactMe config={{ contact: { endpoint: null } }} />);
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: values.Name } });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: values.Email } });
  expect(window.location.assign).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Open email draft" }));
  const body = new URL(window.location.assign.mock.calls[0][0]).searchParams.get("body");
  expect(body).toContain('I have a question about your article "Protein stability & binding":');
  expect(body).toContain("https://desmondgilmour.com/writing/runtime-protein-notes");
  expect(body).not.toContain("dev.to");
  expect(screen.getByRole("status")).toHaveTextContent("nothing has been sent from this website");
  expect(fetch).not.toHaveBeenCalled();
});

test("the reusable resolver accepts an explicit server article index and rejects unusable origins", () => {
  const index = [{ slug: "server-only-post", title: "Server archive title" }];
  expect(articleQuestionMessage("?article=server-only-post", "https://live.example", index)).toContain("https://live.example/writing/server-only-post");
  expect(articleQuestionMessage("?article=server-only-post", "https://live.example")).toBe("");
  expect(articleQuestionMessage("?article=server-only-post", "null", index)).toBe("");
  expect(articleQuestionMessage("?article=server-only-post", "javascript:alert(1)", index)).toBe("");
});

test("static HTML includes the resolved article question and a usable native form", () => {
  const message = articleQuestionMessage("?article=server-post", "https://live.example", [{ slug: "server-post", title: "A <useful> article" }]);
  const html = renderToStaticMarkup(<ContactMe config={configured} initialMessage={message} />);
  const document = new DOMParser().parseFromString(html, "text/html");
  expect(document.querySelector('textarea[name="message"]').value).toBe(message);
  expect(document.querySelector("useful")).toBeNull();
  expect(document.querySelector("form").getAttribute("action")).toBe("/api/contact");
  expect(document.querySelector("form").getAttribute("method")).toBe("post");
  expect(document.querySelector("form").hasAttribute("novalidate")).toBe(false);
  expect(document.querySelector('textarea[name="message"]').required).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});

test("an explicit initial message cannot overwrite a visitor's edits when props change", () => {
  const { rerender } = render(<ContactMe config={configured} initialMessage="An initial question" />);
  expect(screen.getByLabelText("Message")).toHaveValue("An initial question");
  fill();
  rerender(<ContactMe config={configured} initialMessage="A different question" />);
  retained();
  expect(fetch).not.toHaveBeenCalled();
});
