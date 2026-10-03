interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** Content growth cannot detach follow mode; only scrolling upward away from the bottom can. */
export class ScrollFollow {
  following = true;
  private lastTop = 0;

  recordFollow(scrollTop: number) {
    this.lastTop = scrollTop;
  }

  observeScroll({ scrollTop, scrollHeight, clientHeight }: ScrollMetrics) {
    const distance = Math.max(0, scrollHeight - clientHeight - scrollTop);
    const movingUp = scrollTop < this.lastTop - 1;
    if (this.following && movingUp && distance > 80) this.following = false;
    else if (!this.following && distance <= 24) this.following = true;
    this.lastTop = scrollTop;
  }
}
