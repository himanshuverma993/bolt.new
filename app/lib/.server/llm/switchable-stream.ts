export default class SwitchableStream extends TransformStream {
  private _controller: TransformStreamDefaultController | null = null;
  private _currentReader: ReadableStreamDefaultReader | null = null;
  private _switches = 0;
  private _closed = false;

  constructor() {
    let controllerRef: TransformStreamDefaultController | undefined;

    super({
      start(controller) {
        controllerRef = controller;
      },
    });

    if (controllerRef === undefined) {
      throw new Error('Controller not properly initialized');
    }

    this._controller = controllerRef;
  }

  async switchSource(newStream: ReadableStream) {
    if (this._currentReader) {
      await this._currentReader.cancel();
    }

    this._currentReader = newStream.getReader();

    this._pumpStream();

    this._switches++;
  }

  private async _pumpStream() {
    if (!this._currentReader || !this._controller) {
      throw new Error('Stream is not properly initialized');
    }

    try {
      while (true) {
        const { done, value } = await this._currentReader.read();

        /**
         * `close()` runs from the provider's onFinish callback, which can fire
         * while the trailing stream parts are still in flight: once the stream
         * is terminated those parts are dropped instead of raising an error.
         */
        if (done || this._closed) {
          break;
        }

        this._controller.enqueue(value);
      }
    } catch (error) {
      if (this._closed) {
        return;
      }

      console.log(error);
      this._controller.error(error);
    }
  }

  close() {
    this._closed = true;

    if (this._currentReader) {
      this._currentReader.cancel();
    }

    this._controller?.terminate();
  }

  get switches() {
    return this._switches;
  }
}
