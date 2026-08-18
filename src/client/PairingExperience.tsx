import { type ReactNode, type SyntheticEvent, useCallback, useEffect, useRef, useState } from "react";
import type { PairingConnection, PairingIdentity } from "./pairing.js";
import { pairingDisplayFingerprint } from "./pairing.js";

interface PairingOnboardingProps {
  organizationName: string;
  ownerDisplayName: string;
  ompProfile: string;
  controllerConnected: boolean;
  expectedIdentity: PairingIdentity | null;
  onPair: (link: string) => Promise<void>;
  onForget: () => void;
}

interface PairedSessionProps {
  connection: PairingConnection;
  onDisconnect: () => void;
}

interface DetectedBarcode {
  rawValue?: string;
}

interface BarcodeDetectorInstance {
  detect(source: HTMLVideoElement): Promise<DetectedBarcode[]>;
}

interface BarcodeDetectorConstructor {
  new (options: { formats: string[] }): BarcodeDetectorInstance;
  getSupportedFormats?: () => Promise<string[]>;
}

export function PairingOnboarding({
  organizationName,
  ownerDisplayName,
  ompProfile,
  controllerConnected,
  expectedIdentity,
  onPair,
  onForget,
}: PairingOnboardingProps): ReactNode {
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [scannerActive, setScannerActive] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const scannerSupported =
    typeof window !== "undefined" &&
    "BarcodeDetector" in window &&
    Boolean(navigator.mediaDevices?.getUserMedia);

  const attemptPair = useCallback(
    async (candidate: string) => {
      setBusy(true);
      setError(null);
      setLink("");
      try {
        await onPair(candidate);
      } catch (pairingError) {
        setError(pairingError instanceof Error ? pairingError.message : "OMP pairing failed.");
      } finally {
        setBusy(false);
      }
    },
    [onPair],
  );

  useEffect(() => {
    if (!scannerActive) return;
    let cancelled = false;
    let stream: MediaStream | null = null;
    let animationFrame = 0;

    const stop = () => {
      cancelled = true;
      if (animationFrame) cancelAnimationFrame(animationFrame);
      for (const track of stream?.getTracks() ?? []) track.stop();
      if (videoRef.current) videoRef.current.srcObject = null;
    };

    const start = async () => {
      try {
        const Detector = (window as unknown as { BarcodeDetector?: BarcodeDetectorConstructor })
          .BarcodeDetector;
        if (!Detector || !navigator.mediaDevices?.getUserMedia) {
          throw new Error("QR scanning is unavailable in this browser. Paste the full-control link instead.");
        }
        const formats = (await Detector.getSupportedFormats?.()) ?? ["qr_code"];
        if (!formats.includes("qr_code")) {
          throw new Error("This browser cannot scan QR codes. Paste the full-control link instead.");
        }
        const detector = new Detector({ formats: ["qr_code"] });
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: "environment" } },
        });
        if (cancelled) return;
        const video = videoRef.current;
        if (!video) throw new Error("The QR camera surface did not initialize.");
        video.srcObject = stream;
        await video.play();

        const scan = async () => {
          if (cancelled) return;
          try {
            const result = (await detector.detect(video)).find((item) => item.rawValue?.trim());
            if (result?.rawValue) {
              stop();
              setScannerActive(false);
              await attemptPair(result.rawValue);
              return;
            }
          } catch {
            stop();
            setScannerActive(false);
            setError("The QR frame could not be read. Paste the full-control link instead.");
            return;
          }
          animationFrame = requestAnimationFrame(() => void scan());
        };
        animationFrame = requestAnimationFrame(() => void scan());
      } catch (scannerError) {
        stop();
        setScannerActive(false);
        const detail = scannerError instanceof Error ? scannerError.message : "QR scanning failed";
        setError(
          detail.includes("Paste")
            ? detail
            : `QR camera unavailable: ${detail.replace(/\.$/, "")}. Paste the full-control link instead.`,
        );
      }
    };

    void start();
    return stop;
  }, [attemptPair, scannerActive]);

  const submit = (event: SyntheticEvent<HTMLFormElement, SubmitEvent>) => {
    event.preventDefault();
    if (!link.trim() || busy) return;
    void attemptPair(link);
  };

  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText("/collab");
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setError("Clipboard access was denied. Type /collab in the intended OMP session.");
    }
  };

  const profileMismatch = expectedIdentity && expectedIdentity.ompProfile !== ompProfile;

  return (
    <main className="pairing-gate">
      <header className="pairing-brand">
        <span className="pairing-brand-mark" aria-hidden="true">
          A
        </span>
        <div>
          <p className="eyebrow">{organizationName}</p>
          <h1>ACCOMP-lish</h1>
        </div>
        <span className={`pairing-controller-state ${controllerConnected ? "online" : "offline"}`}>
          <i /> {controllerConnected ? "Local controller ready" : "Local controller reconnecting"}
        </span>
      </header>

      <section className="pairing-card" aria-labelledby="pairing-title">
        <div className="pairing-intro">
          <span className="pairing-step-label">Secure first connection</span>
          <h2 id="pairing-title">Pair one exact OMP session</h2>
          <p>
            The profile selects local OMP configuration. The full-control <code>/collab</code> link
            cryptographically selects the exact external session loaded into this control surface.
          </p>
        </div>

        <div className="pairing-profile-row">
          <div>
            <span>Configured OMP profile</span>
            <strong>{ompProfile}</strong>
          </div>
          <div>
            <span>Human owner</span>
            <strong>{ownerDisplayName}</strong>
          </div>
        </div>

        {expectedIdentity ? (
          <div className={`pairing-binding ${profileMismatch ? "mismatch" : ""}`}>
            <div>
              <span>{profileMismatch ? "Configuration mismatch" : "Remembered session"}</span>
              <strong>
                Profile {expectedIdentity.ompProfile} · Room {pairingDisplayFingerprint(expectedIdentity)}
              </strong>
              <p>
                {profileMismatch
                  ? `Setup now selects ${ompProfile}. Forget the old binding before pairing this profile.`
                  : "Paste the same full-control link to reconnect. A different room will be rejected."}
              </p>
            </div>
            <button type="button" className="pairing-text-button danger" onClick={onForget}>
              Forget binding
            </button>
          </div>
        ) : null}

        <ol className="pairing-steps">
          <li>
            <span>1</span>
            <div>
              <strong>Open the intended session</strong>
              <p>
                Use the terminal session running under OMP profile <code>{ompProfile}</code>.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Create the full-control room</strong>
              <p>Run this local OMP command. OMP will display a QR code and a private link.</p>
              <div className="pairing-command">
                <code>/collab</code>
                <button type="button" onClick={() => void copyCommand()}>
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Bind this browser</strong>
              <p>
                Scan the QR code or paste the full-control value printed after{" "}
                <strong>or any web browser</strong>. The visible <code>my.omp.sh/#…</code> form is accepted.
              </p>
            </div>
          </li>
        </ol>

        <form className="pairing-form" onSubmit={submit}>
          <label htmlFor="omp-collab-link">Full-control OMP collaboration link</label>
          <div className="pairing-input-row">
            <input
              id="omp-collab-link"
              type="password"
              value={link}
              onChange={(event) => setLink(event.target.value)}
              placeholder="Paste the private /collab link"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              data-1p-ignore="true"
              disabled={busy || profileMismatch === true}
            />
            <button
              className="pairing-primary-button"
              type="submit"
              disabled={!link.trim() || busy || profileMismatch === true}
            >
              {busy ? "Pairing…" : "Pair session"}
            </button>
          </div>
          <button
            className="pairing-scan-button"
            type="button"
            disabled={!scannerSupported || busy || profileMismatch === true}
            onClick={() => {
              setError(null);
              setScannerActive(true);
            }}
          >
            <span aria-hidden="true">▦</span> Scan the OMP QR code
          </button>
          {!scannerSupported ? (
            <small>Camera QR scanning is unavailable in this browser; paste the link instead.</small>
          ) : null}
          {error ? (
            <p className="pairing-error" role="alert">
              {error}
            </p>
          ) : null}
        </form>

        <div className="pairing-security-note">
          <strong>The link is a bearer secret.</strong>
          <span>
            The Control Center does not send it to its API, database, logs, or browser storage. Only a
            non-secret SHA-256 room fingerprint is remembered. Reloading requires the same link again.
          </span>
        </div>
      </section>

      {scannerActive ? (
        <div className="pairing-scanner-backdrop" role="presentation">
          <section
            className="pairing-scanner"
            role="dialog"
            aria-modal="true"
            aria-labelledby="scanner-title"
          >
            <div>
              <p className="eyebrow">Camera</p>
              <h2 id="scanner-title">Center the OMP QR code</h2>
            </div>
            <video ref={videoRef} muted playsInline aria-label="QR scanner camera preview" />
            <p>The image stays in this browser and is used only to read the collaboration link.</p>
            <button
              type="button"
              className="pairing-secondary-button"
              onClick={() => setScannerActive(false)}
            >
              Cancel scan
            </button>
          </section>
        </div>
      ) : null}
    </main>
  );
}

export function PairedSession({ connection, onDisconnect }: PairedSessionProps): ReactNode {
  return (
    <section className="paired-session" aria-labelledby="paired-session-title">
      <header className="paired-session-header">
        <div>
          <p className="eyebrow">Full-control OMP collaboration</p>
          <h2 id="paired-session-title">Paired OMP Session</h2>
          <p>
            Profile <strong>{connection.identity.ompProfile}</strong> · Room fingerprint{" "}
            <strong>{pairingDisplayFingerprint(connection.identity)}</strong>
          </p>
        </div>
        <button className="danger-button" type="button" onClick={onDisconnect}>
          Disconnect room
        </button>
      </header>
      <div className="paired-session-boundary">
        <div className="paired-session-status">
          <span>
            <i /> Exact room loaded
          </span>
          <small>Connection and participant status inside this OMP panel are authoritative.</small>
        </div>
        <iframe
          title="Paired OMP collaboration session"
          src={connection.clientUrl}
          referrerPolicy="no-referrer"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals"
          allow="clipboard-read; clipboard-write"
        />
      </div>
      <div className="paired-session-footnote">
        Temporary relay outages reconnect inside the OMP client. Disconnecting removes the full-control key
        from this page but keeps the non-secret room fingerprint, so another session cannot be substituted
        silently.
      </div>
    </section>
  );
}
