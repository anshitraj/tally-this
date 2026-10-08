import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import "./styles/finverify-refresh.css";
import { installAuthenticatedFetch } from "@/lib/auth";

installAuthenticatedFetch();

createRoot(document.getElementById("root")!).render(<App />);
