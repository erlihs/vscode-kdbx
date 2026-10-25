export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    // Keep the queue usable; the original result still rejects to its caller.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
