import { createFileRoute } from "@tanstack/react-router"
import { LoginPage } from "../pages/LoginPage"

// `/login` — public. Email + password sign-in.
export const Route = createFileRoute("/login")({
  component: LoginPage,
})
