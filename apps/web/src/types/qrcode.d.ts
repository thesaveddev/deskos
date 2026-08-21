declare module 'qrcode' {
  interface QrCodeOptions {
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H'
    width?: number
    margin?: number
    color?: {
      dark?: string
      light?: string
    }
  }

  const QRCode: {
    toCanvas(canvas: HTMLCanvasElement, text: string, options?: QrCodeOptions): Promise<HTMLCanvasElement>
  }

  export default QRCode
}
