/** Single <video> fed by the webcam or a looping fixture. The stream outlives route changes (SHELL-3). */
export class VideoSource {
  readonly video = Object.assign(document.createElement('video'), { muted: true, playsInline: true });
  kind: 'off' | 'camera' | 'fixture' = 'off';
  private stream?: MediaStream;

  /** Resolves false when permission is denied or no camera exists. */
  async startCamera(): Promise<boolean> {
    if (this.kind === 'camera') return true;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
    } catch {
      return false;
    }
    this.video.srcObject = this.stream;
    this.kind = 'camera';
    await this.video.play();
    return true;
  }

  /** Plays fixtures/<name>.webm (or .mp4) on loop instead of the webcam (IN-6). */
  async startFixture(name: string): Promise<void> {
    if (!/^[\w-]+$/.test(name)) throw new Error(`invalid fixture name: ${name}`);
    this.stop();
    const v = this.video;
    v.loop = true;
    v.replaceChildren(
      ...['webm', 'mp4'].map((ext) => Object.assign(document.createElement('source'), { src: `${import.meta.env.BASE_URL}fixtures/${name}.${ext}` })),
    );
    v.load();
    this.kind = 'fixture';
    await v.play();
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = undefined;
    this.video.pause();
    this.video.srcObject = null;
    this.video.replaceChildren();
    this.video.removeAttribute('src');
    this.kind = 'off';
  }

  /** True once the current source has a decodable frame. */
  get ready(): boolean {
    return this.kind !== 'off' && this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
  }
}
