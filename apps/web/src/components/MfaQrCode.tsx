import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'

export function MfaQrCode({ value }: { value: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    setError(null)
    const canvas = canvasRef.current
    if (!canvas || !value) return

    try {
      void QRCode.toCanvas(canvas, value, {
        errorCorrectionLevel: 'M',
        width: 220,
        margin: 2,
        color: {
          dark: '#17212b',
          light: '#ffffff',
        },
      }).catch(() => {
        if (active) setError('The QR code could not be rendered. Use the setup key below instead.')
      })
    } catch {
      setError('The QR code could not be rendered. Use the setup key below instead.')
    }

    return () => {
      active = false
    }
  }, [value])

  return (
    <div className="mfa-qr-block">
      {error ? <p className="field-hint">{error}</p> : <canvas ref={canvasRef} className="mfa-qr" aria-label="MFA setup QR code" />}
      <span className="field-hint">Scan this code with your authenticator app. ReyDesk generates it locally in your browser.</span>
    </div>
  )
}
