import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { KestrelRuntimeProvider } from "./chat/KestrelRuntime";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) throw new Error("Kestrel UI root was not found");

createRoot(root).render(
  <StrictMode>
    <KestrelRuntimeProvider>
      <App />
    </KestrelRuntimeProvider>
  </StrictMode>,
);
