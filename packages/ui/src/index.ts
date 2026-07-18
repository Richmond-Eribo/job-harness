// @agent-harness/ui — shadcn/ui component library for the frontend.
//
// Components live in ./components/* and use the semantic CSS-variable tokens
// (bg-background, text-foreground, bg-primary, …) defined in the frontend's
// global CSS (packages/frontend/src/index.css) as @theme inline mappings.
//
// Usage in the frontend:
//   import { Button, Card, CardHeader, Select, Badge } from "@agent-harness/ui"
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
export { Textarea } from "./components/textarea"
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
export {
  Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectLabel,
  SelectItem,
  SelectSeparator,
  SelectScrollUpButton,
  SelectScrollDownButton,
} from "./components/select"
export { Badge, badgeVariants } from "./components/badge"
export { Skeleton } from "./components/skeleton"
export { Separator } from "./components/separator"
export { Toaster } from "./components/sonner"
export {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "./components/tooltip"
