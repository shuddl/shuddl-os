// Vite `?raw` imports load a file's exact text (the same mechanism as sql-raw.d.ts / csv-raw.d.ts).
// stream-id-parity.test.ts reads sequencer.ts and contracts/events.ts verbatim to diff the ONE regex both
// declare — see audit §228: the DO's copy carries a "MUST stay byte-identical" comment and nothing
// enforced it, so widening it left all 752 api tests green.
declare module "*.ts?raw" {
  const content: string;
  export default content;
}
