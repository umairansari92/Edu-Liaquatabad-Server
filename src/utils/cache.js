/**
 * In-Memory TTL Cache with Cascading Invalidation
 * Education Department Liaquatabad Town Centre (DMC)
 *
 * Provides sub-millisecond in-process caching for analytics & dashboard overviews.
 * Zero external dependency. Cascades school updates to town-wide overviews.
 */

class MemoryCache {
  constructor() {
    this.store = new Map();
    // Auto-evict expired keys every 60 seconds
    this.cleanupTimer = setInterval(() => this.cleanup(), 60000);
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref(); // Don't block Node process exit
    }
  }

  /**
   * Get cached item
   * @param {string} key
   * @returns {any|null}
   */
  get(key) {
    const item = this.store.get(key);
    if (!item) return null;
    if (Date.now() > item.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return item.value;
  }

  /**
   * Set cached item with TTL in seconds
   * @param {string} key
   * @param {any} value
   * @param {number} ttlSeconds (default: 180s / 3 mins)
   */
  set(key, value, ttlSeconds = 180) {
    const expiresAt = Date.now() + (ttlSeconds * 1000);
    this.store.set(key, { value, expiresAt });
  }

  /**
   * Delete a specific key
   * @param {string} key
   */
  del(key) {
    this.store.delete(key);
  }

  /**
   * Delete all keys starting with a prefix
   * @param {string} prefix
   */
  delByPrefix(prefix) {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
  }

  /**
   * Cascading invalidation: Invalidates school analytics AND town-wide overviews
   * @param {string} schoolId
   */
  invalidateSchool(schoolId) {
    const idStr = String(schoolId);
    this.delByPrefix(`school:${idStr}`);
    this.delByPrefix('town:overview');
  }

  /**
   * Remove expired entries
   */
  cleanup() {
    const now = Date.now();
    for (const [key, item] of this.store.entries()) {
      if (now > item.expiresAt) {
        this.store.delete(key);
      }
    }
  }

  /**
   * Clear entire cache
   */
  flush() {
    this.store.clear();
  }

  /**
   * Size of cache
   */
  get size() {
    return this.store.size;
  }
}

const cache = new MemoryCache();
export default cache;
