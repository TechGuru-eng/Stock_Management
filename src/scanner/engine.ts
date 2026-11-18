import { describeBarcode } from '../domain/barcode'

/**
 * Camera barcode reading. Uses the browser's built-in BarcodeDetector where it exists (Chrome and Edge on Android and
 * desktop: fast, no download). Elsewhere (iPhone Safari, Firefox) it loads a small JavaScript reader the first time it
 * is needed. Everything runs on the device; no image ever leaves it.
 */
export interface ScanSession {
  stop(): void
  torchSupported: boolean
  setTorch(on: boolean): Promise<void>
}

export type ScanError = 'no_camera' | 'denied' | 'insecure' | 'unsupported'

export class ScannerError extends Error {
  code: ScanError
  constructor(code: ScanError) {
    super(code)
    this.name = 'ScannerError'
    this.code = code
  }
}

const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'codabar']

/** A read is believable unless it is a standard retail code whose last digit does not fit (a misread). */
export function plausible(code: string): boolean {
  return describeBarcode(code).checksumOk !== false
}

interface DetectorCtor { new (o?: { formats: string[] }): { detect(v: HTMLVideoElement): Promise<{ rawValue: string }[]> } }

export async function startScanning(video: HTMLVideoElement, onCode: (code: string) => void): Promise<ScanSession> {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new ScannerError(window.isSecureContext ? 'unsupported' : 'insecure')
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
  } catch (e) {
    const name = (e as DOMException).name
    throw new ScannerError(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'no_camera')
  }
  video.srcObject = stream
  video.setAttribute('playsinline', 'true')
  await video.play().catch(() => undefined)

  const track = stream.getVideoTracks()[0]
  const caps = (track.getCapabilities?.() ?? {}) as { torch?: boolean }
  let stopped = false
  let stopReader: () => void = () => undefined

  const Native = (window as unknown as { BarcodeDetector?: DetectorCtor }).BarcodeDetector
  if (Native) {
    const detector = new Native({ formats: FORMATS })
    const timer = setInterval(() => {
      if (stopped || video.readyState < 2) return
      detector.detect(video).then((found) => { if (!stopped && found[0]) onCode(found[0].rawValue) }, () => undefined)
    }, 150)
    stopReader = () => clearInterval(timer)
  } else {
    const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([import('@zxing/browser'), import('@zxing/library')])
    const hints = new Map<unknown, unknown>([[DecodeHintType.POSSIBLE_FORMATS, [
      BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E, BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.ITF, BarcodeFormat.CODABAR,
    ]], [DecodeHintType.TRY_HARDER, true]])
    const reader = new BrowserMultiFormatReader(hints as never, { delayBetweenScanAttempts: 150 })
    const controls = await reader.decodeFromStream(stream, video, (result) => { if (!stopped && result) onCode(result.getText()) })
    stopReader = () => controls.stop()
  }

  return {
    torchSupported: Boolean(caps.torch),
    async setTorch(on) {
      await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] })
    },
    stop() {
      stopped = true
      stopReader()
      stream.getTracks().forEach((t) => t.stop())
      video.srcObject = null
    },
  }
}

/** A short beep and a buzz so the person knows without looking at the screen. */
export function feedback(): void {
  try { navigator.vibrate?.(60) } catch { /* not supported */ }
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const ctx = new Ctx()
    const osc = ctx.createOscillator()
    osc.frequency.value = 1800
    osc.connect(ctx.destination)
    osc.start()
    osc.stop(ctx.currentTime + 0.08)
    setTimeout(() => void ctx.close(), 300)
  } catch { /* silent device */ }
}
