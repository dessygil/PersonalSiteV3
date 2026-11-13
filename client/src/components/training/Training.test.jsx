import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import Training from "./Training";

jest.mock("../../lib/siteConfig", () => ({ getSiteConfig: () => ({ strava: { widgetUrl: null, summaryWidgetUrl: null, profileUrl: null } }) }));

const widgetUrl = "https://www.strava.com/athletes/12345/latest-rides/test-widget-token";
const summaryWidgetUrl = "https://www.strava.com/athletes/12345/activity-summary/test-summary-token";
const profileUrl = "https://www.strava.com/athletes/12345";
const summaryTitle = "Desmond Gilmour’s Strava activity summary";
const latestTitle = "Desmond Gilmour’s latest Strava activities";

test("the training introduction remains useful without a configured Strava account", () => {
  render(<Training />);
  expect(screen.getByRole("heading", { name: "Training for a half Ironman." })).toBeInTheDocument();
  expect(screen.getByText("05 / STRAVA")).toBeInTheDocument();
  expect(screen.queryByText("The race distances")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Load Strava activity" })).not.toBeInTheDocument();
  expect(screen.queryByTitle(summaryTitle)).not.toBeInTheDocument();
  expect(screen.queryByTitle(latestTitle)).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Follow my training on Strava" })).not.toBeInTheDocument();
});

test("one visitor choice loads the summary above recent activity at their official sizes", () => {
  render(<Training config={{ strava: { widgetUrl, summaryWidgetUrl, profileUrl } }} />);
  expect(screen.queryByTitle(summaryTitle)).not.toBeInTheDocument();
  expect(screen.queryByTitle(latestTitle)).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Follow my training on Strava" })).toHaveAttribute("href", profileUrl);
  fireEvent.click(screen.getByRole("button", { name: "Load Strava activity" }));
  const summary = screen.getByTitle(summaryTitle);
  const latest = screen.getByTitle(latestTitle);
  expect(summary).toHaveAttribute("src", summaryWidgetUrl);
  expect(summary).toHaveAttribute("height", "160");
  expect(latest).toHaveAttribute("src", widgetUrl);
  expect(latest).toHaveAttribute("height", "454");
  for (const iframe of [summary, latest]) {
    expect(iframe).toHaveAttribute("loading", "lazy");
    expect(iframe).toHaveAttribute("width", "300");
    expect(iframe).toHaveAttribute("referrerpolicy", "no-referrer");
  }
  expect(screen.getAllByTitle(/Desmond Gilmour’s.*Strava/).map(iframe => iframe.getAttribute("src"))).toEqual([summaryWidgetUrl, widgetUrl]);
});

test("the summary can be configured independently of the activity feed", () => {
  render(<Training config={{ strava: { summaryWidgetUrl } }} />);
  fireEvent.click(screen.getByRole("button", { name: "Load Strava activity" }));
  expect(screen.getByTitle(summaryTitle)).toHaveAttribute("src", summaryWidgetUrl);
  expect(screen.queryByTitle(latestTitle)).not.toBeInTheDocument();
});

test("keyboard loading moves focus to the labelled widget region without entering an iframe", async () => {
  const user = userEvent.setup();
  render(<Training config={{ strava: { widgetUrl, summaryWidgetUrl } }} />);
  await user.tab();
  expect(screen.getByRole("button", { name: "Load Strava activity" })).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(screen.getByRole("region", { name: "Training updates" })).toHaveFocus();
  expect(screen.getByTitle(summaryTitle)).not.toHaveFocus();
  expect(screen.getByTitle(latestTitle)).not.toHaveFocus();
});

test("the existing activity feed still works without a summary", () => {
  render(<Training config={{ strava: { widgetUrl } }} />);
  fireEvent.click(screen.getByRole("button", { name: "Load Strava activity" }));
  expect(screen.getByTitle(latestTitle)).toHaveAttribute("src", widgetUrl);
  expect(screen.queryByTitle(summaryTitle)).not.toBeInTheDocument();
});

test.each([
  "https://www.strava.com.example.com/athletes/12345/latest-rides/token",
  "https://www.strava.com@evil.example/athletes/12345/latest-rides/token",
  "http://www.strava.com/athletes/12345/latest-rides/token",
  "https://www.strava.com/activities/12345",
  // eslint-disable-next-line no-script-url -- Exercise rejection of executable URLs.
  "javascript:alert(1)",
  "https://www.strava.com/athletes/12345/latest-rides/"
])("unapproved widget URLs do not create a load control or embed: %s", value => {
  render(<Training config={{ strava: { widgetUrl: value, summaryWidgetUrl: value, profileUrl: "https://evil.example/athletes/12345" } }} />);
  expect(screen.queryByRole("button", { name: "Load Strava activity" })).not.toBeInTheDocument();
  expect(screen.queryByTitle(summaryTitle)).not.toBeInTheDocument();
  expect(screen.queryByTitle(latestTitle)).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Follow my training on Strava" })).not.toBeInTheDocument();
});

test.each([
  { widgetUrl: summaryWidgetUrl },
  { summaryWidgetUrl: widgetUrl }
])("each configured widget must use its own official endpoint", strava => {
  render(<Training config={{ strava }} />);
  expect(screen.queryByRole("button", { name: "Load Strava activity" })).not.toBeInTheDocument();
});

test("an invalid summary does not prevent a valid activity feed from loading", () => {
  render(<Training config={{ strava: { widgetUrl, summaryWidgetUrl: "https://evil.example/activity-summary/token" } }} />);
  fireEvent.click(screen.getByRole("button", { name: "Load Strava activity" }));
  expect(screen.getByTitle(latestTitle)).toHaveAttribute("src", widgetUrl);
  expect(screen.queryByTitle(summaryTitle)).not.toBeInTheDocument();
});

test("adding a summary requires a fresh visitor choice for the configured widgets", () => {
  const { rerender } = render(<Training config={{ strava: { widgetUrl } }} />);
  fireEvent.click(screen.getByRole("button", { name: "Load Strava activity" }));
  expect(screen.getByTitle(latestTitle)).toBeInTheDocument();
  rerender(<Training config={{ strava: { widgetUrl, summaryWidgetUrl } }} />);
  expect(screen.queryByTitle(summaryTitle)).not.toBeInTheDocument();
  expect(screen.queryByTitle(latestTitle)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Load Strava activity" }));
  expect(screen.getByTitle(summaryTitle)).toHaveAttribute("src", summaryWidgetUrl);
  expect(screen.getByTitle(latestTitle)).toHaveAttribute("src", widgetUrl);
});
