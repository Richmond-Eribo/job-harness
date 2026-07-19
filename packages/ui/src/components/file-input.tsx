import * as React from "react"

import { cn } from "../lib/utils"

// File input styled to match the rest of the form controls. shadcn doesn't
// ship a dedicated file component, so this centralises the file: pseudo
// styling that would otherwise be duplicated across pages.
function FileInput({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type="file"
      data-slot="file-input"
      className={cn(
        "w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-4 file:py-2 file:text-secondary-foreground file:font-medium file:cursor-pointer hover:file:bg-secondary/80 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  )
}

export { FileInput }
