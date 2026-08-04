declare module 'jsdom' {
  export class JSDOM {
    window: any;
    constructor(html?: string, options?: any);
  }
  export class VirtualConsole {
    on(event: string, handler: (...args: any[]) => void): this;
  }
}
