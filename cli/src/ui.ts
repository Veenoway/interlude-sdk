/**
 * Terminal output, kept deliberately plain.
 *
 * Colour only where it separates one kind of line from another, because a developer reading this
 * is looking for one fact — an address, a port, a reason something failed — and decoration is
 * what they have to read past to find it.
 */

const useColour = process.stdout.isTTY && !process.env["NO_COLOR"];

const paint = (code: string, text: string) => (useColour ? `\u001b[${code}m${text}\u001b[0m` : text);

export const bold = (text: string) => paint("1", text);
export const dim = (text: string) => paint("2", text);
export const green = (text: string) => paint("32", text);
export const red = (text: string) => paint("31", text);
export const yellow = (text: string) => paint("33", text);

export function step(message: string): void {
  process.stdout.write(`\n${bold(`== ${message}`)}\n`);
}

export function say(message: string): void {
  process.stdout.write(`${message}\n`);
}

export function note(message: string): void {
  process.stdout.write(`${dim(message)}\n`);
}

export function ok(message: string): void {
  process.stdout.write(`${green("ok")} ${message}\n`);
}

export function warn(message: string): void {
  process.stdout.write(`${yellow("!")} ${message}\n`);
}

/** A pair of columns, for the summary a reader copies addresses out of. */
export function pairs(rows: [string, string][]): void {
  const width = Math.max(...rows.map(([label]) => label.length));
  for (const [label, value] of rows) {
    process.stdout.write(`  ${label.padEnd(width)}  ${value}\n`);
  }
}

export function fail(message: string): never {
  process.stderr.write(`\n${red("error")} ${message}\n`);
  process.exitCode = 1;
  throw new Bail();
}

/** Thrown by `fail` so the top level can exit without printing a stack over the message. */
export class Bail extends Error {}
