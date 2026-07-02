/**
 * QueueProvenance: a queue_item_id -> provider-track provenance map, captured at
 * ENQUEUE time so a later queue rebuild (edit_queue) can re-queue the EXACT same
 * recording rather than re-matching by title.
 *
 * Why this exists: Roon's get_queue exposes each item's stable queue_item_id plus
 * title/artist/album, but NOT a provider (Qobuz) track ID. The deterministic
 * re-queue path (queue_by_id) needs a provider ID. The only place that ID is
 * known is the moment the item was enqueued via queue_by_id / play_by_id, so we
 * record it here keyed by the queue_item_id Roon assigned. edit_queue then looks
 * it up to replay the exact recording; when an item has no entry (queued by the
 * Roon GUI, by name search, or before this process started) edit_queue falls
 * back to title+artist re-resolution and flags it.
 *
 * In-memory and best-effort: it lives only for the bridge process lifetime and is
 * bounded so it cannot grow without limit. A miss is always safe (fallback path).
 */

export interface QueueItemProvenance {
  /** Provider track ID (e.g. a Qobuz track id) - the deterministic re-queue key. */
  providerId: string;
  /** Which provider the id belongs to. */
  provider?: string;
  title: string;
  artist: string | null;
  album: string | null;
  trackNumber: number | null;
}

/** Keep the map bounded; a Roon queue is rarely more than a few hundred items. */
const MAX_ENTRIES = 1000;

class QueueProvenanceStore {
  private readonly map = new Map<number, QueueItemProvenance>();

  /** Record the provider provenance for a freshly-enqueued queue_item_id. */
  record(queueItemId: number, prov: QueueItemProvenance): void {
    // Re-insert at the end so the Map's insertion order acts as a simple LRU.
    this.map.delete(queueItemId);
    this.map.set(queueItemId, prov);
    if (this.map.size > MAX_ENTRIES) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  /** Look up provenance for a queue_item_id, or undefined if unknown. */
  get(queueItemId: number): QueueItemProvenance | undefined {
    return this.map.get(queueItemId);
  }

  /** Drop an entry (e.g. once it is known to have left the queue). */
  forget(queueItemId: number): void {
    this.map.delete(queueItemId);
  }

  /** Current entry count (for tests / diagnostics). */
  size(): number {
    return this.map.size;
  }

  /** Clear all entries (tests). */
  clear(): void {
    this.map.clear();
  }
}

/** Process-wide singleton, shared by the enqueue paths and edit_queue. */
export const queueProvenance = new QueueProvenanceStore();
