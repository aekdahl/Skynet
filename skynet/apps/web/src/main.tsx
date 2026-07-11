import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./styles.responsive.css";
import { App } from "./App";
import { StoreProvider } from "./lib/store";
import { AcceptanceProvider } from "./lib/acceptance-store";
import { SimulationProvider } from "./lib/simulation-store";
import { setupPwa } from "./pwa/pwa";

setupPwa();

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

createRoot(root).render(
  <StrictMode>
    <StoreProvider>
      <AcceptanceProvider>
        <SimulationProvider>
          <App />
        </SimulationProvider>
      </AcceptanceProvider>
    </StoreProvider>
  </StrictMode>,
);
