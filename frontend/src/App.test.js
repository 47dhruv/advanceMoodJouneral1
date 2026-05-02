import { render, screen } from "@testing-library/react";
import App from "./App";

jest.mock("axios", () => {
  const instance = {
    get: jest.fn(() => new Promise(() => {})),
    post: jest.fn(() => new Promise(() => {}))
  };

  return {
    __esModule: true,
    default: {
      create: jest.fn(() => instance)
    }
  };
});

test("renders journal studio heading", () => {
  render(<App />);
  const heading = screen.getByRole("heading", { name: /advanced mood journal/i });
  expect(heading).toBeInTheDocument();
});
