// @agent-harness/ui — shadcn/ui component library for the frontend.
//
// Components live in ./components/* and use the semantic CSS-variable tokens
// (bg-background, text-foreground, bg-primary, …) defined in the frontend's
// global CSS (packages/frontend/src/index.css). The tokens map onto the
// existing slate-based "ink" dark palette so the look stays consistent.
//
// Usage in the frontend:
//   import { Button, Card, CardHeader } from "@agent-harness/ui"
//   import { Input } from "@agent-harness/ui/components/input"
export { cn } from "./lib/utils"
export { Button, buttonVariants, type ButtonProps } from "./components/button"
export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardDescription,
  CardContent,
} from "./components/card"
export { Input } from "./components/input"
export { Label } from "./components/label"
export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "./components/dialog"
