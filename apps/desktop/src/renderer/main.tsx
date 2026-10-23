import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import "./styles/tokens.css";
import "./styles/app.css";

const container = document.getElementById("root");
if (container === null) {
  throw new Error("Renderer root element is missing");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
