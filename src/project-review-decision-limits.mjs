// Shared finite bound for canonical private P1/P1b decision.json files.
// The first profile permits at most 100 attestations with 256-character paths,
// two 64-hex hashes and a 4,096-byte note. JSON control escaping can expand
// that note to 24,576 bytes; the remaining rows and fixed fields fit below
// 96 KiB. Producers check before reserving output and consumers use this cap.
export const MAX_REVIEW_DECISION_BYTES=96*1024;
