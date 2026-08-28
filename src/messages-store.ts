// dsh-deepartments — agent messaging store (spec 003 §3): the plugin-owned
// append-only message log `<stateDir>/messages.jsonl` plus the write-ahead
// delivery sidecar `<stateDir>/deliveries.jsonl` (§4.4).
//
// FASE 2 STEP b: the implementation has MOVED to `./core/messages.js`. This
// module is now a pure RE-EXPORT BRIDGE so the existing compiled surface
// (`lib/messages-store.js`) stays a drop-in superset: tests (and every other
// consumer) import the same symbols from the same path they always have, while
// the store + redelivery guard are OWNED by `src/core/messages.ts` (which
// compiles to `lib/core/messages.js`).
//
// The bridge re-exports the value + type surface unchanged (the on-disk
// messages.jsonl / deliveries.jsonl format is byte-identical — R6). ALTO-1
// (QD audit 2026-08-28 F1): the compaction id + sidecar remap pair
// (`compactionIdMap` / `remapDeliveryRows`) is part of the public surface —
// the id-STABLE sidecar contract consumers rely on (tests import them here).
//
// NO export default (pitfall 0001 — breaks `inject`).
export {
  MESSAGE_FILE,
  DELIVERIES_FILE,
  resolveMessagesPath,
  resolveDeliveriesPath,
  parseMessageRecords,
  loadMessageRecords,
  appendMessageRecord,
  COMPACTION_LINE_THRESHOLD,
  COMPACTION_BYTE_THRESHOLD,
  shouldCompact,
  compactionIdMap,
  compactMessages,
  loadMemberIds,
  compactMessagesFile,
  remapDeliveryRows,
  MessagesStore,
  parseDeliveryRows,
  markDelivery,
  deliveryStatus,
  needsRedelivery,
  compactDeliveryRows,
  DeliveryRedeliverer
} from './core/messages.js'
export type {
  MessageKind,
  MessageRecord,
  MessageInput,
  DeliveryStatus,
  DeliveryRow,
  PageOptions,
  PageResult,
  DeliveryRedelivererDeps
} from './core/messages.js'
