/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Mic, Square, Loader2, CheckCircle, CircleStop } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { generateParticipantResponse, evaluateInterview, generateSpeech, transcribeAudio, Message, EvaluationResult, TTSVoice } from './services/api';
import * as pdfjsLib from 'pdfjs-dist';

pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;

type AppState = 'idle' | 'interviewing' | 'evaluating' | 'completed';
// listening  = mic button is actively recording the user's voice
// processing = recording stopped, waiting for Whisper + AI response + TTS
// speaking   = AI audio is playing back
// waiting    = idle between turns (not recording, not speaking)
type InteractionState = 'waiting' | 'listening' | 'processing' | 'speaking';

export default function App() {
  const [appState, setAppState] = useState<AppState>('idle');
  const [interactionState, setInteractionState] = useState<InteractionState>('waiting');
  const [transcript, setTranscript] = useState<Message[]>([]);
  const [evaluation, setEvaluation] = useState<EvaluationResult | null>(null);

  // Knowledge Base State
  const [knowledgeBaseText, setKnowledgeBaseText] = useState<string>('');
  const [currentVoice, setCurrentVoice] = useState<TTSVoice>('alloy');

  // Refs
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const silenceRafRef = useRef<number | null>(null);
  const [silenceCountdown, setSilenceCountdown] = useState<number | null>(null);
  const silenceCountdownRef = useRef<number | null>(null);
  const hasSpeechRef = useRef(false); // true once we detect the user actually spoke

  // Stable refs to avoid stale closures inside async chains
  const appStateRef = useRef(appState);
  const interactionStateRef = useRef(interactionState);
  const transcriptRef = useRef(transcript);
  const knowledgeBaseTextRef = useRef(knowledgeBaseText);
  const currentVoiceRef = useRef(currentVoice);

  useEffect(() => { appStateRef.current = appState; }, [appState]);
  useEffect(() => { interactionStateRef.current = interactionState; }, [interactionState]);
  useEffect(() => { transcriptRef.current = transcript; }, [transcript]);
  useEffect(() => { knowledgeBaseTextRef.current = knowledgeBaseText; }, [knowledgeBaseText]);
  useEffect(() => { currentVoiceRef.current = currentVoice; }, [currentVoice]);

  const knowledgeFilesEnv = (import.meta as any).env.VITE_KNOWLEDGE_FILES || '';

  // Load knowledge base files on mount
  useEffect(() => {
    const fetchKnowledgeBase = async () => {
      const filesToLoad = knowledgeFilesEnv.split(',').map((s: string) => s.trim()).filter((f: string) => f.length > 0);
      if (filesToLoad.length === 0) return;

      let extractedText = '';
      for (const fileName of filesToLoad) {
        try {
          const response = await fetch(`/${fileName}`);
          if (!response.ok) continue;

          if (fileName.endsWith('.pdf')) {
            const arrayBuffer = await response.arrayBuffer();
            const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
            for (let i = 1; i <= pdf.numPages; i++) {
              const page = await pdf.getPage(i);
              const textContent = await page.getTextContent();
              const pageText = textContent.items.map((item: any) => item.str).join(' ');
              extractedText += pageText + '\n';
            }
          } else {
            extractedText += (await response.text()) + '\n';
          }
        } catch (err) {
          console.error(`Failed to parse ${fileName}`, err);
        }
      }
      setKnowledgeBaseText(extractedText);
    };
    fetchKnowledgeBase();
  }, [knowledgeFilesEnv]);

  // Auto-scroll transcript
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcript, interactionState]);

  // ─── Audio Utilities ────────────────────────────────────────────────────────

  /**
   * On mobile (especially iOS), audio playback is blocked unless triggered
   * within a user-gesture handler. We unlock the AudioContext on first tap
   * so subsequent programmatic plays succeed.
   */
  const unlockAudioContext = () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    if (audioContextRef.current.state === 'suspended') {
      audioContextRef.current.resume();
    }
  };

  const cancelAudioPlayback = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = '';
      audioRef.current = null;
    }
  };

  const stopSilenceDetection = () => {
    if (silenceRafRef.current !== null) {
      cancelAnimationFrame(silenceRafRef.current);
      silenceRafRef.current = null;
    }
    if (silenceTimerRef.current !== null) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    setSilenceCountdown(null);
    silenceCountdownRef.current = null;
  };

  // ─── Recording ──────────────────────────────────────────────────────────────

  // How long silence must last before auto-submitting (ms)
  const SILENCE_DELAY = 1500;
  // RMS threshold below which audio is considered silence (0–255 scale)
  const SILENCE_THRESHOLD = 10;

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // ── Silence detection via AnalyserNode ──────────────────────────
      // Reuse or create an AudioContext (must stay alive for iOS)
      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
      if (audioContextRef.current.state === 'suspended') {
        await audioContextRef.current.resume();
      }
      const source = audioContextRef.current.createMediaStreamSource(stream);
      const analyser = audioContextRef.current.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      analyserRef.current = analyser;
      hasSpeechRef.current = false;

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      let silenceStart: number | null = null;

      const checkSilence = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteTimeDomainData(dataArray);

        // Compute RMS volume
        let sumSq = 0;
        for (let i = 0; i < dataArray.length; i++) {
          const val = dataArray[i] - 128; // centre around 0
          sumSq += val * val;
        }
        const rms = Math.sqrt(sumSq / dataArray.length);

        if (rms > SILENCE_THRESHOLD) {
          // User is speaking — reset silence timer
          hasSpeechRef.current = true;
          silenceStart = null;
          if (silenceTimerRef.current !== null) {
            clearTimeout(silenceTimerRef.current);
            silenceTimerRef.current = null;
          }
          setSilenceCountdown(null);
          silenceCountdownRef.current = null;
        } else if (hasSpeechRef.current) {
          // Silence detected after speech — start countdown
          if (silenceStart === null) silenceStart = performance.now();
          const elapsed = performance.now() - silenceStart;
          const remaining = Math.max(0, SILENCE_DELAY - elapsed);
          const secs = Math.ceil(remaining / 1000);

          if (silenceCountdownRef.current !== secs) {
            silenceCountdownRef.current = secs;
            setSilenceCountdown(secs);
          }

          if (elapsed >= SILENCE_DELAY && silenceTimerRef.current === null) {
            // Auto-submit!
            silenceTimerRef.current = setTimeout(() => {
              stopSilenceDetection();
              stopRecordingAndProcess();
            }, 0);
          }
        }

        silenceRafRef.current = requestAnimationFrame(checkSilence);
      };

      silenceRafRef.current = requestAnimationFrame(checkSilence);
      // ────────────────────────────────────────────────────────────────

      // Pick the best supported mime type across browsers/iOS
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', '']
        .find(t => !t || MediaRecorder.isTypeSupported(t)) ?? '';

      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      recorder.start(250);
      setInteractionState('listening');
    } catch (err) {
      console.error('Microphone error:', err);
      alert('Microphone permission was denied or unavailable.');
    }
  };

  const stopRecordingAndProcess = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === 'inactive') return;

    stopSilenceDetection();
    setInteractionState('processing');

    recorder.onstop = async () => {
      // Stop all tracks to release mic indicator on mobile
      recorder.stream.getTracks().forEach(t => t.stop());

      const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
      audioChunksRef.current = [];
      mediaRecorderRef.current = null;

      if (blob.size < 1000) {
        // Too small — user probably tapped by accident
        if (appStateRef.current === 'interviewing') {
          setInteractionState('waiting');
        }
        return;
      }

      // Whisper STT
      const spokenText = await transcribeAudio(blob);

      if (!spokenText || appStateRef.current !== 'interviewing') {
        setInteractionState('waiting');
        return;
      }

      await handleUserSpeech(spokenText);
    };

    recorder.stop();
  }, []);

  // ─── Main Conversation Logic ─────────────────────────────────────────────────

  const handleUserSpeech = async (text: string) => {
    const isChangeSubject = text.toLowerCase().includes('replace participant');

    if (isChangeSubject) {
      const voices: TTSVoice[] = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
      const next = voices[(voices.indexOf(currentVoiceRef.current) + 1) % voices.length];
      setCurrentVoice(next);
      currentVoiceRef.current = next;
    }

    const newTranscript: Message[] = [...transcriptRef.current, { speaker: 'user', text }];
    setTranscript(newTranscript);
    transcriptRef.current = newTranscript;

    // Generate AI text response
    const responseText = await generateParticipantResponse(newTranscript, knowledgeBaseTextRef.current, isChangeSubject);

    if (appStateRef.current !== 'interviewing') return;

    // Generate TTS audio
    const audioUrl = await generateSpeech(responseText, currentVoiceRef.current);

    if (appStateRef.current !== 'interviewing') return;

    // Update transcript with participant reply
    setTranscript(prev => [...prev, { speaker: 'participant', text: responseText }]);

    if (audioUrl) {
      setInteractionState('speaking');

      const audio = new Audio(audioUrl);
      audioRef.current = audio;

      const onDone = () => {
        if (appStateRef.current === 'interviewing') {
          setInteractionState('waiting');
        }
      };

      audio.onended = onDone;
      audio.onerror = onDone;

      // play() returns a promise — catch silent failures on mobile
      audio.play().catch(err => {
        console.error('Audio play failed:', err);
        onDone();
      });
    } else {
      // TTS failed — just go back to waiting so user can speak again
      setInteractionState('waiting');
    }
  };

  // ─── Session Control ─────────────────────────────────────────────────────────

  const startInterview = async () => {
    // Unlock AudioContext immediately inside this user-gesture handler
    unlockAudioContext();

    setAppState('interviewing');
    setTranscript([]);
    setEvaluation(null);
    setInteractionState('waiting');
  };

  const endInterview = async () => {
    // Stop any ongoing recording + silence detection
    stopSilenceDetection();
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stream.getTracks().forEach(t => t.stop());
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
    }

    cancelAudioPlayback();
    setAppState('evaluating');
    setInteractionState('waiting');

    const finalTranscript = [...transcriptRef.current];
    if (finalTranscript.length === 0) {
      setAppState('idle');
      return;
    }

    const result = await evaluateInterview(finalTranscript);
    setEvaluation(result);
    setAppState('completed');
  };

  // ─── Button Handler ───────────────────────────────────────────────────────────

  const handleMicButton = () => {
    unlockAudioContext(); // always unlock on tap

    if (appState === 'idle' || appState === 'completed') {
      startInterview();
      return;
    }

    if (appState !== 'interviewing') return;

    if (interactionState === 'listening') {
      // User taps again → stop recording and process
      stopRecordingAndProcess();
    } else if (interactionState === 'speaking') {
      // Interrupt AI playback and go back to waiting
      cancelAudioPlayback();
      setInteractionState('waiting');
    } else if (interactionState === 'waiting') {
      // Start a new recording turn
      startRecording();
    }
    // 'processing' — do nothing, wait for it to complete
  };

  const handleEndButton = () => {
    endInterview();
  };

  // ─── Derived UI Helpers ───────────────────────────────────────────────────────

  const micLabel = (() => {
    if (appState === 'idle' || appState === 'completed') return 'Tap to Start';
    if (interactionState === 'listening') {
      if (silenceCountdown !== null && silenceCountdown > 0) return `Sending in ${silenceCountdown}s…`;
      return 'Listening… (tap to send early)';
    }
    if (interactionState === 'processing') return 'Processing…';
    if (interactionState === 'speaking') return 'Tap to Interrupt';
    return 'Tap to Speak'; // waiting
  })();

  const micIcon = (() => {
    if (appState === 'idle' || appState === 'completed') return <Mic size={36} className="text-white drop-shadow-[0_2px_4px_rgba(0,0,0,0.4)]" />;
    if (interactionState === 'listening') return <Square size={28} fill="currentColor" className="text-white" />;
    if (interactionState === 'processing') return <Loader2 size={28} className="text-white animate-spin" />;
    if (interactionState === 'speaking') return <CircleStop size={28} className="text-purple-300" />;
    return <Mic size={32} className="text-white" />; // waiting
  })();

  const micButtonClass = (() => {
    const base = 'relative w-24 h-24 rounded-full flex items-center justify-center shadow-2xl transition-all duration-300 outline-none cursor-pointer select-none';
    if (appState === 'idle' || appState === 'completed') return `${base} bg-gradient-to-br from-blue-600 to-purple-600 active:scale-95`;
    if (interactionState === 'listening') return `${base} bg-red-600 active:scale-95 shadow-[0_0_40px_rgba(220,38,38,0.5)]`;
    if (interactionState === 'processing') return `${base} bg-slate-800 border border-white/10 opacity-70`;
    if (interactionState === 'speaking') return `${base} bg-purple-900 border border-purple-500/30 active:scale-95`;
    return `${base} bg-gradient-to-br from-emerald-600 to-blue-600 active:scale-95`; // waiting
  })();

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col font-sans text-slate-200 relative overflow-hidden selection:bg-purple-500/30">
      {/* Ambient glow orbs */}
      <div className="absolute top-[-20%] left-[-10%] w-[500px] h-[500px] bg-purple-600/20 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute bottom-[-20%] right-[-10%] w-[500px] h-[500px] bg-blue-600/20 rounded-full blur-[120px] pointer-events-none" />

      <header className="px-4 py-3 sm:py-5 flex items-center justify-center bg-slate-950/60 backdrop-blur-xl border-b border-white/5 sticky top-0 z-10 shadow-[0_10px_30px_-10px_rgba(0,0,0,0.5)]">
        <h1 className="text-xs sm:text-sm font-bold bg-gradient-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent tracking-widest uppercase drop-shadow-sm">Participant Simulator</h1>
      </header>

      <main className="flex-1 w-full max-w-3xl mx-auto px-4 py-4 sm:p-6 flex flex-col overflow-y-auto pb-44 sm:pb-56 z-10">

        {/* Idle state */}
        {appState === 'idle' && transcript.length === 0 && (
          <div className="flex-1 flex items-center justify-center text-slate-500 font-light">
            <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} className="flex flex-col items-center gap-5">
              <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-full bg-gradient-to-br from-slate-800 to-slate-900 flex items-center justify-center border border-white/10 shadow-[0_0_30px_rgba(0,0,0,0.3)]">
                <Mic className="text-slate-400" size={28} />
              </div>
              <p className="text-center tracking-wide text-sm sm:text-base px-4">
                Tap the button below to start.<br />
                <span className="text-xs opacity-70 mt-2 block">Say "Replace Participant" to switch persona</span>
              </p>
            </motion.div>
          </div>
        )}

        {/* Evaluating state */}
        {appState === 'evaluating' && (
          <div className="flex-1 flex flex-col items-center justify-center text-center">
            <Loader2 size={44} className="animate-spin text-purple-500 mb-5 drop-shadow-[0_0_15px_rgba(168,85,247,0.5)]" />
            <p className="text-slate-400 text-base sm:text-xl font-medium tracking-wide">Evaluating your interview…</p>
          </div>
        )}

        {/* Transcript */}
        {transcript.length > 0 && (
          <div className="flex flex-col space-y-6 sm:space-y-10 mt-3 sm:mt-4">
            <AnimatePresence>
              {transcript.map((msg, idx) => (
                <motion.div
                  initial={{ opacity: 0, y: 12, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  key={idx}
                  className={`flex flex-col ${msg.speaker === 'user' ? 'items-end' : 'items-start'}`}
                >
                  <span className={`text-[9px] sm:text-[10px] font-bold uppercase tracking-widest mb-1.5 ${msg.speaker === 'user' ? 'text-blue-400' : 'text-purple-400'}`}>
                    {msg.speaker === 'user' ? 'You' : 'Participant'}
                  </span>
                  <p className={`text-base sm:text-xl md:text-2xl leading-relaxed font-light max-w-[90%] ${msg.speaker === 'user' ? 'text-slate-400 text-right' : 'text-slate-100 drop-shadow-sm'}`}>
                    {msg.text}
                  </p>
                </motion.div>
              ))}
            </AnimatePresence>

            {/* Processing indicator */}
            {interactionState === 'processing' && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-start">
                <span className="text-[9px] sm:text-[10px] font-bold uppercase tracking-widest text-purple-400 mb-1.5">Thinking…</span>
                <div className="flex gap-1.5 mt-2 bg-slate-800/50 py-2.5 px-3.5 rounded-2xl border border-white/5 shadow-inner backdrop-blur-sm">
                  {[0, 0.2, 0.4].map((delay, i) => (
                    <motion.div key={i} animate={{ y: [0, -5, 0], opacity: [0.4, 1, 0.4] }} transition={{ repeat: Infinity, duration: 0.8, delay }} className="w-2 h-2 sm:w-2.5 sm:h-2.5 bg-purple-400 rounded-full shadow-[0_0_8px_rgba(192,132,252,0.6)]" />
                  ))}
                </div>
              </motion.div>
            )}
          </div>
        )}

        {/* Evaluation Result */}
        {appState === 'completed' && evaluation && (
          <motion.div initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col items-center justify-center py-6 sm:py-10 mt-6 sm:mt-10 border-t border-white/10">
            <div className="text-7xl sm:text-9xl font-black bg-gradient-to-br from-white to-slate-500 bg-clip-text text-transparent mb-1 tracking-tighter drop-shadow-lg">
              {evaluation.score}<span className="text-4xl sm:text-5xl text-slate-600">/10</span>
            </div>
            <h3 className="text-lg sm:text-2xl font-bold text-slate-200 mb-5 sm:mb-8 flex items-center gap-2 sm:gap-3">
              <CheckCircle className="text-emerald-400 drop-shadow-[0_0_15px_rgba(52,211,153,0.4)]" size={24} />
              Evaluation Complete
            </h3>
            <div className="bg-slate-900/60 backdrop-blur-md rounded-2xl sm:rounded-3xl p-5 sm:p-8 border border-white/10 w-full shadow-[0_20px_50px_-12px_rgba(0,0,0,0.8)] text-left flex flex-col gap-5 sm:gap-6">
              <div>
                <h4 className="text-emerald-400 font-bold uppercase tracking-wider text-[10px] sm:text-xs mb-2 sm:mb-3">Positive Feedback</h4>
                <p className="text-slate-300 whitespace-pre-wrap leading-relaxed text-sm sm:text-lg font-light">{String(evaluation.positiveFeedback).replace(/^"|"$/g, '')}</p>
              </div>
              {evaluation.constructiveFeedback && (
                <>
                  <div className="w-full h-px bg-white/10 block" />
                  <div>
                    <h4 className="text-amber-400 font-bold uppercase tracking-wider text-[10px] sm:text-xs mb-2 sm:mb-3">Constructive Criticism</h4>
                    <p className="text-slate-300 whitespace-pre-wrap leading-relaxed text-sm sm:text-lg font-light">{String(evaluation.constructiveFeedback).replace(/^"|"$/g, '')}</p>
                  </div>
                </>
              )}
            </div>
          </motion.div>
        )}

        <div ref={transcriptEndRef} className="h-10" />
      </main>

      {/* Bottom Controls */}
      {(appState === 'idle' || appState === 'interviewing' || appState === 'completed') && (
        <div
          className="fixed bottom-0 left-0 right-0 flex flex-col items-center z-20 pt-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] bg-gradient-to-t from-slate-950 via-slate-950/90 to-transparent"
        >
          {/* Listening pulse ring */}
          {interactionState === 'listening' && (
            <motion.div
              className="absolute top-4 w-24 h-24 sm:w-28 sm:h-28 rounded-full border-2 border-red-500/50"
              animate={{ scale: [1, 1.4, 1], opacity: [0.6, 0, 0.6] }}
              transition={{ repeat: Infinity, duration: 1.5 }}
            />
          )}

          <button
            onClick={handleMicButton}
            disabled={interactionState === 'processing'}
            className={micButtonClass}
            style={{ WebkitTapHighlightColor: 'transparent' }}
          >
            {/* Speaking ring */}
            {interactionState === 'speaking' && (
              <motion.div animate={{ rotate: -360 }} transition={{ repeat: Infinity, duration: 1.5, ease: 'linear' }} className="absolute inset-[-4px] rounded-full border-[3px] border-transparent border-t-purple-500 border-b-purple-500" />
            )}
            {micIcon}
          </button>

          <span className="mt-2.5 text-[10px] font-bold tracking-widest uppercase text-slate-500 drop-shadow-sm text-center">
            {micLabel}
          </span>

          {/* End Interview button */}
          {appState === 'interviewing' && interactionState !== 'processing' && (
            <button
              onClick={handleEndButton}
              className="mt-2 px-5 py-1.5 rounded-full text-[11px] font-bold uppercase tracking-widest text-slate-500 border border-white/10 active:border-red-500/40 active:text-red-400 transition-all duration-200 active:scale-95"
              style={{ WebkitTapHighlightColor: 'transparent' }}
            >
              End Interview
            </button>
          )}
        </div>
      )}
    </div>
  );
}
