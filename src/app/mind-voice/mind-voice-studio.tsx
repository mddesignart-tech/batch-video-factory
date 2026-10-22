"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { Bookmark, BookmarkCheck, Download, HardDrive, Mic, Play, RefreshCw, ShieldCheck } from "lucide-react";
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Field, ProgressBar, Select, Textarea } from "@/components/ui";
import { mindInstallAction, mindMp3Action, mindSaveTakeAction, mindSpeakAction, mindStatusAction, mindVerifyAction, type MindStatus } from "@/app/actions/mind-voice";
import { MIND_AUTO_VOICE, MIND_ENGINES, MIND_MAX_SPEED, MIND_MIN_SPEED, mindVoiceLabel, type MindEngineId, type MindModelStatus } from "@/domain/mind-voice";
import { VOICE_EMOTIONS, VOICE_STYLES, type VoiceEmotionId, type VoiceStyleId } from "@/domain/voice-director";
import type { StudioPause, StudioTake } from "@/services/mind-voice-studio";

const mediaUrl = (rel: string) => `/api/media/${rel.split(/[\\/]/).map(encodeURIComponent).join("/")}`;
const mb = (bytes: number | null | undefined) => (bytes ? `${Math.round(bytes / 1e6)} MB` : "?");

const SAMPLE: Record<"vi" | "en", string> = {
  vi: "Bạn có biết, chỉ cần uống một ly nước ngay sau khi thức dậy, cơ thể sẽ tỉnh táo hơn hẳn? Thói quen nhỏ này không tốn tiền, cũng chẳng mất thêm thời gian.",
  en: "Did you know that a single glass of water right after you wake up can make you feel more alert? It costs nothing, and it takes no extra time.",
};

export function MindVoiceStudio({ initialStatus, initialTakes }: { initialStatus: MindStatus; initialTakes: StudioTake[] }) {
  const [status, setStatus] = useState(initialStatus);
  const [takes, setTakes] = useState(initialTakes);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, start] = useTransition();
  const [checking, startCheck] = useTransition();

  const refresh = (remoteSizes = false) =>
    startCheck(async () => {
      setStatus(await mindStatusAction({ remoteSizes }));
    });

  // While a model is downloading, ask every 2 s.
  const installing = status.models.some((m) => m.job?.state === "running");
  useEffect(() => {
    if (!installing) return;
    const t = setInterval(() => void mindStatusAction().then(setStatus), 2000);
    return () => clearInterval(t);
  }, [installing]);

  // ------------------------------------------------------------ the form ---
  const [text, setText] = useState(SAMPLE.vi);
  const [language, setLanguage] = useState<"vi" | "en">("vi");
  const [voiceId, setVoiceId] = useState<string>(MIND_AUTO_VOICE);
  const [style, setStyle] = useState<VoiceStyleId | "">("");
  const [emotion, setEmotion] = useState<VoiceEmotionId>("AUTO");
  const [speed, setSpeed] = useState(1);
  const [pause, setPause] = useState<StudioPause>("natural");
  const [current, setCurrent] = useState<StudioTake | null>(initialTakes[0] ?? null);

  const engine: MindEngineId = language === "vi" ? "vieneu" : "supertonic";
  const voices = useMemo(() => status.voices.filter((v) => v.engine === engine && v.installed), [status.voices, engine]);
  const engineModel = status.models.find((m) => m.id === engine);

  const speak = (preview: boolean) =>
    start(async () => {
      setMessage(null);
      const r = await mindSpeakAction({ text, language, voiceId, style: style || null, emotion, speed, pause, preview });
      setMessage({ ok: r.ok, text: r.message });
      if (r.take) {
        setCurrent(r.take);
        setTakes((list) => [r.take!, ...list.filter((t) => t.id !== r.take!.id)]);
      }
    });

  const toggleSave = (take: StudioTake) =>
    start(async () => {
      const r = await mindSaveTakeAction(take.id, !take.saved);
      setMessage({ ok: r.ok, text: r.message });
      if (r.ok) {
        const next = { ...take, saved: !take.saved };
        setTakes((list) => list.map((t) => (t.id === take.id ? next : t)));
        if (current?.id === take.id) setCurrent(next);
      }
    });

  const mp3 = (take: StudioTake) =>
    start(async () => {
      const r = await mindMp3Action(take.id);
      setMessage({ ok: r.ok, text: r.message });
      if (r.mp3) {
        const next = { ...take, mp3: r.mp3 };
        setTakes((list) => list.map((t) => (t.id === take.id ? next : t)));
        if (current?.id === take.id) setCurrent(next);
        window.location.href = mediaUrl(r.mp3);
      }
    });

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="space-y-6">
        {/* ------------------------------------------------------ status */}
        <Card>
          <CardContent className="flex flex-wrap items-center gap-3 py-3 text-sm">
            <span className={status.online ? "font-semibold text-ok-500" : "font-semibold text-warn-500"}>{status.online ? "● Mind Voice đang chạy" : "● Mind Voice chưa chạy"}</span>
            <span className="text-ink-400">{status.baseUrl}</span>
            {status.health ? (
              <span className="text-ink-400">
                {status.health.device === "cpu" ? "CPU" : "GPU"} · {status.health.hardware.threads ?? "?"} luồng · RAM {status.health.hardware.ramGb ?? "?"} GB
                {status.health.hardware.gpu ? ` · ${status.health.hardware.gpu}` : ""}
              </span>
            ) : null}
            <Button size="sm" variant="ghost" disabled={checking} onClick={() => refresh()}>
              <RefreshCw className="h-3 w-3" /> Kiểm tra lại
            </Button>
          </CardContent>
          {!status.online ? (
            <CardContent className="pt-0">
              <Alert tone="warn" title="Chưa kết nối được Mind Voice">
                {status.message} Lần đầu dùng: chạy <code>voice-engine\setup_voice_engine.bat</code> (cài môi trường Python riêng, ~0,8 GB, không đụng Python của Windows).
              </Alert>
            </CardContent>
          ) : null}
          {status.health?.gpuNote ? <CardContent className="pt-0 text-xs text-ink-500">{status.health.gpuNote}</CardContent> : null}
        </Card>

        {/* -------------------------------------------------- generation */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Mic className="h-4 w-4" /> Tạo giọng
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field label="Nội dung cần đọc" hint={`${text.length}/3000 ký tự · nhãn như "Narrator:", "Speaker A:", "Host:" ở đầu dòng sẽ không bị đọc`}>
              <Textarea rows={6} value={text} onChange={(e) => setText(e.currentTarget.value)} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Ngôn ngữ">
                <Select
                  value={language}
                  onChange={(e) => {
                    const next = e.currentTarget.value as "vi" | "en";
                    setLanguage(next);
                    setVoiceId(MIND_AUTO_VOICE);
                    if (text === SAMPLE[language]) setText(SAMPLE[next]);
                  }}
                >
                  <option value="vi">Tiếng Việt</option>
                  <option value="en">English</option>
                </Select>
              </Field>
              <Field label="Engine">
                <div className="flex h-9 items-center gap-2 text-sm text-ink-200">
                  {MIND_ENGINES[engine].label}
                  {engineModel?.installed ? <Badge tone="ok">đã cài</Badge> : <Badge tone="warn">chưa cài</Badge>}
                </div>
              </Field>
              <Field label={`Giọng (${voices.length})`}>
                <Select value={voiceId} onChange={(e) => setVoiceId(e.currentTarget.value)}>
                  <option value={MIND_AUTO_VOICE}>Tự động (giọng mặc định)</option>
                  {voices.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.featured ? "★ " : ""}
                      {mindVoiceLabel(v)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Phong cách">
                <Select value={style} onChange={(e) => setStyle(e.currentTarget.value as VoiceStyleId | "")}>
                  <option value="">Tự nhiên (không thêm gì)</option>
                  {Object.entries(VOICE_STYLES).map(([id, s]) => (
                    <option key={id} value={id}>
                      {s.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Cảm xúc">
                <Select value={emotion} onChange={(e) => setEmotion(e.currentTarget.value as VoiceEmotionId)}>
                  {VOICE_EMOTIONS.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Ngắt nghỉ">
                <Select value={pause} onChange={(e) => setPause(e.currentTarget.value as StudioPause)}>
                  <option value="natural">Tự nhiên theo dấu câu</option>
                  <option value="long" disabled={engine !== "vieneu"}>
                    Nghỉ dài hơn giữa các câu{engine !== "vieneu" ? " (chỉ VieNeu)" : ""}
                  </option>
                </Select>
              </Field>
            </div>
            <Field label={`Tốc độ: ${speed.toFixed(2)}x`} hint={engine === "vieneu" ? "VieNeu không có tốc độ gốc: khác 1x sẽ được co giãn sau khi tạo, giữ cao độ giọng." : "Supertonic tự đọc theo tốc độ này."}>
              <input type="range" min={MIND_MIN_SPEED} max={MIND_MAX_SPEED} step={0.05} value={speed} onChange={(e) => setSpeed(Number(e.currentTarget.value))} className="w-full accent-brand-500" />
            </Field>
            <p className="text-xs text-ink-500">
              Cảm xúc chỉ dùng thẻ engine thật sự hiểu: VieNeu [cười] [thở dài] [hắng giọng]; Supertonic &lt;laugh&gt; &lt;sigh&gt; &lt;breath&gt;. Bạn có thể tự gõ các thẻ này vào nội dung.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" disabled={busy || !status.online || !engineModel?.installed} onClick={() => speak(true)}>
                <Play className="h-4 w-4" /> Nghe thử
              </Button>
              <Button variant="primary" disabled={busy || !status.online || !engineModel?.installed} onClick={() => speak(false)}>
                <Mic className="h-4 w-4" /> {busy ? "Đang tạo…" : "Tạo giọng"}
              </Button>
            </div>
            {message ? <Alert tone={message.ok ? "ok" : "warn"}>{message.text}</Alert> : null}
            {current ? <TakePlayer take={current} busy={busy} onSave={toggleSave} onMp3={mp3} /> : null}
          </CardContent>
        </Card>

        <History takes={takes} busy={busy} onPick={setCurrent} onSave={toggleSave} />
      </div>

      {/* ------------------------------------------------- model manager */}
      <ModelManager status={status} checking={checking} onRefresh={refresh} onChanged={setStatus} />
    </div>
  );
}

function TakePlayer({ take, busy, onSave, onMp3 }: { take: StudioTake; busy: boolean; onSave: (t: StudioTake) => void; onMp3: (t: StudioTake) => void }) {
  return (
    <div className="space-y-2 rounded-lg border border-ink-800 bg-ink-850 p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-ink-400">
        <span className="font-medium text-ink-200">{take.voiceLabel}</span>
        <span>· {MIND_ENGINES[take.engine].label}</span>
        <span>· {take.durationSec.toFixed(1)} s</span>
        <span>· {take.speed.toFixed(2)}x</span>
        {take.preview ? <Badge tone="info">nghe thử</Badge> : null}
        <Badge tone="ok">$0</Badge>
      </div>
      <audio key={take.id} controls src={mediaUrl(take.file)} className="w-full" />
      <div className="flex flex-wrap gap-2">
        <a href={mediaUrl(take.file)} download>
          <Button size="sm" variant="secondary" type="button">
            <Download className="h-3 w-3" /> Tải WAV
          </Button>
        </a>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => onMp3(take)}>
          <Download className="h-3 w-3" /> Tải MP3
        </Button>
        <Button size="sm" variant={take.saved ? "ghost" : "secondary"} disabled={busy} onClick={() => onSave(take)}>
          {take.saved ? <BookmarkCheck className="h-3 w-3" /> : <Bookmark className="h-3 w-3" />}
          {take.saved ? "Đã lưu trong thư viện" : "Lưu vào thư viện giọng"}
        </Button>
      </div>
    </div>
  );
}

function History({ takes, busy, onPick, onSave }: { takes: StudioTake[]; busy: boolean; onPick: (t: StudioTake) => void; onSave: (t: StudioTake) => void }) {
  const [onlySaved, setOnlySaved] = useState(false);
  const shown = takes.filter((t) => !onlySaved || t.saved).slice(0, 50);
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>{onlySaved ? "Thư viện giọng" : "Lịch sử"}</CardTitle>
        <Button size="sm" variant="ghost" onClick={() => setOnlySaved((v) => !v)}>
          {onlySaved ? "Xem lịch sử" : "Chỉ bản đã lưu"}
        </Button>
      </CardHeader>
      <CardContent>
        {shown.length === 0 ? (
          <p className="text-sm text-ink-500">{onlySaved ? "Chưa lưu bản nào." : "Chưa tạo giọng nào."}</p>
        ) : (
          <ul className="divide-y divide-ink-800">
            {shown.map((t) => (
              <li key={t.id} className="flex items-center gap-3 py-2 text-sm">
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onPick(t)}>
                  <p className="truncate text-ink-200">{t.text}</p>
                  <p className="text-xs text-ink-500">
                    {t.voiceLabel} · {t.durationSec.toFixed(1)} s · {new Date(t.createdAt).toLocaleString("vi-VN")}
                    {t.preview ? " · nghe thử" : ""}
                  </p>
                </button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => onSave(t)} title={t.saved ? "Bỏ khỏi thư viện" : "Lưu vào thư viện"}>
                  {t.saved ? <BookmarkCheck className="h-4 w-4 text-brand-400" /> : <Bookmark className="h-4 w-4" />}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function ModelManager({ status, checking, onRefresh, onChanged }: { status: MindStatus; checking: boolean; onRefresh: (remote?: boolean) => void; onChanged: (s: MindStatus) => void }) {
  const [busy, start] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ engine: MindEngineId; variant: string } | null>(null);
  const sizesKnown = status.models.some((m) => m.variants.some((v) => v.downloadBytes !== null));

  const install = (engine: MindEngineId, variant: string) =>
    start(async () => {
      setConfirm(null);
      const r = await mindInstallAction(engine, variant);
      setNote(r.message);
      onChanged(await mindStatusAction());
    });
  const verify = (engine: MindEngineId) =>
    start(async () => {
      setNote("Đang kiểm tra checksum…");
      setNote((await mindVerifyAction(engine)).message);
    });

  return (
    <Card className="h-fit">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <HardDrive className="h-4 w-4" /> Quản lý model
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {!status.online ? <p className="text-ink-500">Mind Voice chưa chạy - không đọc được trạng thái model.</p> : null}
        {status.online && !sizesKnown ? (
          <Button size="sm" variant="ghost" disabled={checking} onClick={() => onRefresh(true)}>
            Xem dung lượng tải (hỏi Hugging Face, không tải gì)
          </Button>
        ) : null}
        {status.models.map((m: MindModelStatus) => (
          <div key={m.id} className="space-y-2 rounded-lg border border-ink-800 p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="font-semibold text-ink-100">{m.label}</p>
              {m.installed ? <Badge tone="ok">Đã cài</Badge> : <Badge tone="warn">Chưa cài</Badge>}
            </div>
            <p className="text-xs text-ink-400">
              {m.languages.join(", ")} · {m.sampleRate / 1000} kHz · giấy phép{" "}
              <a className="underline" href={m.licenseUrl} target="_blank" rel="noreferrer">
                {m.license}
              </a>
            </p>
            {m.notes.map((n) => (
              <p key={n} className="text-xs text-ink-500">
                {n}
              </p>
            ))}
            {m.variants.map((v) => (
              <div key={v.id} className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-ink-300">{v.label}</span>
                {v.installed ? (
                  <>
                    <Badge tone="ok">{mb(v.diskBytes)} trên đĩa</Badge>
                    {m.activeVariant === v.id ? <Badge tone="brand">đang dùng</Badge> : null}
                  </>
                ) : (
                  <Button size="sm" variant="secondary" disabled={busy || m.job?.state === "running"} onClick={() => setConfirm({ engine: m.id, variant: v.id })}>
                    Cài ({mb(v.downloadBytes)})
                  </Button>
                )}
                {v.note ? <span className="w-full text-ink-500">{v.note}</span> : null}
              </div>
            ))}
            {m.job?.state === "running" ? (
              <div className="space-y-1">
                <ProgressBar value={m.job.totalBytes ? (m.job.doneBytes / m.job.totalBytes) * 100 : 0} />
                <p className="text-xs text-ink-500">
                  Đang tải {mb(m.job.doneBytes)}/{mb(m.job.totalBytes)} · {m.job.current}
                </p>
              </div>
            ) : null}
            {m.job?.state === "failed" ? <p className="text-xs text-danger-500">Cài lỗi: {m.job.error}</p> : null}
            {m.installed ? (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => verify(m.id)}>
                <ShieldCheck className="h-3 w-3" /> Kiểm tra checksum
              </Button>
            ) : null}
            {confirm?.engine === m.id ? (
              <Alert tone="info" title="Xác nhận cài model">
                Tải {mb(m.variants.find((v) => v.id === confirm.variant)?.downloadBytes)} từ{" "}
                {m.variants
                  .find((v) => v.id === confirm.variant)
                  ?.sources.map((s) => `${s.repo}@${s.revision.slice(0, 8)}`)
                  .join(", ")}
                . Mỗi tệp được kiểm checksum với nguồn chính thức. Giấy phép: {m.license} - {m.attribution}
                <div className="mt-2 flex gap-2">
                  <Button size="sm" variant="primary" disabled={busy} onClick={() => install(confirm.engine, confirm.variant)}>
                    Đồng ý, tải về
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
                    Huỷ
                  </Button>
                </div>
              </Alert>
            ) : null}
          </div>
        ))}
        {note ? <p className="text-xs text-ink-300">{note}</p> : null}
        <p className="text-[11px] text-ink-500">
          Model tải từ repo chính thức trên Hugging Face, ghim theo phiên bản, lưu trong voice-engine\models. Ứng dụng không đóng gói hay phân phối lại model. Chưa có
          nhân bản giọng (voice cloning) và không dùng micro.
        </p>
      </CardContent>
    </Card>
  );
}
