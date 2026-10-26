import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * A readable name from the start of an email address: "anita.rao92@x.com" becomes "Anita Rao". Used for accounts made
 * with only an email and a password, until the person types their own.
 */
export function nameFromEmail(email: string): string {
  const start = email.split("@")[0] ?? "";
  const words = start
    .split(/[._+-]+/)
    .map(word => word.replace(/\d+$/, ""))
    .filter(word => /^[a-z]{2,}$/i.test(word));
  if (words.length === 0) return start;
  return words.map(word => word[0].toUpperCase() + word.slice(1).toLowerCase()).join(" ");
}
