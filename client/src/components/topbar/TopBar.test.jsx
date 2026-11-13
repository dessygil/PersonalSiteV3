import React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import "@testing-library/jest-dom";
import TopBar from "./TopBar";

function renderNavigation(path = "/writing") {
  render(<MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><TopBar /><button type="button">Page control</button></MemoryRouter>);
  return within(screen.getByRole("navigation", { name: "Main navigation" }));
}

test("Escape closes the open navigation and returns keyboard focus to its toggle", async () => {
  const user = userEvent.setup();
  const navigation = renderNavigation();
  const menu = navigation.getByRole("button", { name: "Menu" });
  await user.click(menu);
  await user.tab();
  expect(navigation.getByRole("link", { name: "Experience" })).toHaveFocus();

  await user.keyboard("{Escape}");
  expect(menu).toHaveAttribute("aria-expanded", "false");
  expect(menu).toHaveAccessibleName("Menu");
  expect(menu).toHaveFocus();

  await user.click(screen.getByRole("button", { name: "Page control" }));
  await user.keyboard("{Escape}");
  expect(screen.getByRole("button", { name: "Page control" })).toHaveFocus();
});

test("navigation closes after following a link and announces the current destination", async () => {
  const user = userEvent.setup();
  const navigation = renderNavigation("/writing/a-post");
  const writing = navigation.getByRole("link", { name: "Writing" });
  const experience = navigation.getByRole("link", { name: "Experience" });
  const projects = navigation.getByRole("link", { name: "Projects" });
  expect(writing).toHaveAttribute("aria-current", "page");
  expect(experience).not.toHaveAttribute("aria-current");

  await user.click(navigation.getByRole("button", { name: "Menu" }));
  await user.click(experience);
  expect(navigation.getByRole("button", { name: "Menu" })).toHaveAttribute("aria-expanded", "false");
  expect(experience).toHaveAttribute("aria-current", "location");
  expect(writing).not.toHaveAttribute("aria-current");

  await user.click(projects);
  expect(projects).toHaveAttribute("aria-current", "location");
  expect(experience).not.toHaveAttribute("aria-current");

  const strava = navigation.getByRole("link", { name: "Strava" });
  await user.click(strava);
  expect(strava).toHaveAttribute("aria-current", "location");
  expect(strava).toHaveAttribute("href", "/#Training-anchor");
  expect(projects).not.toHaveAttribute("aria-current");
});
