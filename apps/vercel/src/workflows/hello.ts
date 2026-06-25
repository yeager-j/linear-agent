import { sleep } from "workflow";

// The workflow function orchestrates steps. It must NOT contain Node.js logic
// directly — keep that in "use step" functions (see greet/farewell below).
export async function helloWorkflow(name: string) {
  "use workflow";

  const greeting = await greet(name);

  // Suspend without consuming resources. Could be seconds, days, or months.
  await sleep("5s");

  const farewell = await sayGoodbye(name);

  return { greeting, farewell };
}

async function greet(name: string) {
  "use step";

  console.log(`[step] greeting ${name}`);
  return `Hello, ${name}!`;
}

async function sayGoodbye(name: string) {
  "use step";

  console.log(`[step] saying goodbye to ${name}`);
  return `Goodbye, ${name}!`;
}
