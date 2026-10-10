import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import "./styles/finverify-refresh.css";
import "./styles/incognito.css";
import { installAuthenticatedFetch } from "@/lib/auth";

// Neon returns from Google or GitHub with a one-time note in the address. Only the sign-in page
// can finish the sign-in with it, so the note is handed there from wherever Neon landed.
const loginPath = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/login`;
const returningFromSignIn =
  new URLSearchParams(window.location.search).has("neon_auth_session_verifier") && window.location.pathname !== loginPath;

if (returningFromSignIn) {
  window.location.replace(`${loginPath}${window.location.search}`);
} else {
  installAuthenticatedFetch();
  createRoot(document.getElementById("root")!).render(<App />);
}
