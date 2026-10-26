'use client';

import { Button } from '@hmis/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@hmis/ui/components/dialog';
import { useMutation } from '@tanstack/react-query';
import { Camera, ImageUp, RotateCw, ZoomIn, ZoomOut } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { blobToBase64, compressImage } from '@/lib/compress-image';
import { useErrorText } from '@/lib/use-error-text';
import { useTRPC } from '@/trpc/client';

/**
 * Paper image panel (OPD-02, docs/11 §2.2): the photo of the doctor's handwritten Rx, which stays
 * the original (docs/11 §2.7). "Take photo" uses the webcam / document camera; "Choose picture"
 * takes a file (on a tablet or phone this opens the camera too). Every image is compressed in the
 * browser to ≤ 1600 px, JPEG 0.8 (docs/01 §2) before upload. Zoom and rotate are view-only.
 */
export function ScanPanel({
  encounterId,
  documentId,
  disabled,
  onAttached,
}: {
  encounterId: string;
  documentId: string | null;
  disabled?: boolean;
  onAttached: (documentId: string) => void;
}) {
  const t = useTranslations('rx.scan');
  const errorText = useErrorText();
  const trpc = useTRPC();
  const fileInput = useRef<HTMLInputElement>(null);
  const [zoom, setZoom] = useState(1);
  const [turn, setTurn] = useState(0);
  const [camera, setCamera] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const attach = useMutation(trpc.rx.attachScan.mutationOptions());
  const upload = async (source: Blob | HTMLVideoElement) => {
    setBusy(true);
    setError(null);
    try {
      const jpeg = await compressImage(source);
      const r = await attach.mutateAsync({
        encounterId,
        dataBase64: await blobToBase64(jpeg),
        replacesDocumentId: documentId,
      });
      setZoom(1);
      setTurn(0);
      onAttached(r.documentId);
    } catch (e) {
      setError(
        e instanceof Error && e.message === 'jpeg encoding failed' ? t('failed') : errorText(e),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="rx-paper" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="rx-paper" className="text-xl font-semibold">
          {t('title')}
        </h2>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={disabled || busy}
            onClick={() => setCamera(true)}
          >
            <Camera aria-hidden />
            {t('takePhoto')}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={disabled || busy}
            onClick={() => fileInput.current?.click()}
          >
            <ImageUp aria-hidden />
            {documentId ? t('replace') : t('choose')}
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            capture="environment"
            className="sr-only"
            aria-label={t('choose')}
            data-testid="rx-scan-file"
            tabIndex={-1}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void upload(f);
            }}
          />
        </div>
      </div>

      {busy && (
        <p role="status" className="text-lg">
          {t('uploading')}
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="rounded-lg border-2 border-destructive p-3 font-medium text-destructive"
        >
          {error}
        </p>
      )}

      {documentId ? (
        <div className="space-y-2">
          <div className="flex gap-2">
            <Button
              type="button"
              size="icon"
              variant="outline"
              aria-label={t('zoomOut')}
              onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}
            >
              <ZoomOut aria-hidden />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="outline"
              aria-label={t('zoomIn')}
              onClick={() => setZoom((z) => Math.min(4, z + 0.25))}
            >
              <ZoomIn aria-hidden />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="outline"
              aria-label={t('rotate')}
              onClick={() => setTurn((r) => (r + 90) % 360)}
            >
              <RotateCw aria-hidden />
            </Button>
          </div>
          <div
            className="h-[60vh] overflow-auto rounded-lg border-2 bg-muted"
            data-testid="rx-scan-view"
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- session-checked API image, not optimisable */}
            <img
              src={`/api/documents/rx-scan/${documentId}`}
              alt={t('alt')}
              className="origin-top-left transition-transform"
              style={{
                transform: `scale(${zoom}) rotate(${turn}deg)`,
                maxWidth: zoom === 1 && turn === 0 ? '100%' : 'none',
              }}
            />
          </div>
        </div>
      ) : (
        <p
          className="rounded-lg border-2 border-dashed p-6 text-lg text-muted-foreground"
          data-testid="rx-scan-empty"
        >
          {t('none')}
        </p>
      )}

      {camera && (
        <CameraDialog
          onClose={() => setCamera(false)}
          onCapture={(video) => {
            void upload(video).then(() => setCamera(false));
          }}
        />
      )}
    </section>
  );
}

/** Live camera preview; "Capture" grabs the frame. The stream stops when the dialog closes. */
function CameraDialog({
  onClose,
  onCapture,
}: {
  onClose: () => void;
  onCapture: (video: HTMLVideoElement) => void;
}) {
  const t = useTranslations('rx.scan');
  const video = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(() => !navigator.mediaDevices);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let stopped = false;
    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 } }, audio: false })
      .then((s) => {
        if (stopped) {
          s.getTracks().forEach((tr) => tr.stop());
          return;
        }
        stream = s;
        if (video.current) {
          video.current.srcObject = s;
          void video.current.play();
        }
      })
      .catch(() => setFailed(true));
    return () => {
      stopped = true;
      stream?.getTracks().forEach((tr) => tr.stop());
    };
  }, []);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl" closeLabel={t('cancel')}>
        <DialogTitle>{t('cameraTitle')}</DialogTitle>
        <DialogDescription>{failed ? t('cameraFailed') : t('cameraHint')}</DialogDescription>
        {!failed && <video ref={video} playsInline muted className="w-full rounded-lg bg-black" />}
        <div className="flex flex-wrap justify-end gap-3">
          <Button type="button" variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            type="button"
            disabled={failed}
            onClick={() => video.current && onCapture(video.current)}
          >
            <Camera aria-hidden />
            {t('capture')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
