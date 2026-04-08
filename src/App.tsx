/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { Mic, Square, Loader2, CheckCircle } from 'lucide-react';
import { motion } from 'motion/react';
import { generateParticipantResponse, evaluateInterview, generateSpeech, Message, EvaluationResult, TTSVoice } from './services/api';
import * as pdfjsLib from 'pdfjs-dist';

pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;

type AppState = 'idle' | 'interviewing' | 'evaluating' | 'completed';
type InteractionState = 'waiting' | 'listening' | 'processing' | 'speaking';

export default function App() {
  const [appState, setAppState] = useState<AppState>('idle');
  const [interactionState, setInteractionState] = useState<InteractionState>('waiting');
  const [transcript, setTranscript] = useState<Message[]>([]);
  const [evaluation, setEvaluation] = useState<EvaluationResult | null>(null);
  
  // Knowledge Base State
  const [knowledgeBaseText, setKnowledgeBaseText] = useState<string>('');
  const [currentVoiceURI, setCurrentVoiceURI] = useState<TTSVoice>('alloy');
  
  const recognitionRef = useRef<any>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  // Refs for state access inside event listeners to avoid stale closures
  const appStateRef = useRef(appState);
  const interactionStateRef = useRef(interactionState);
  const transcriptRef = useRef(transcript);
  const speechTimerRef = useRef<NodeJS.Timeout | null>(null);
  const transcriptAccumulatorRef = useRef("");
  const knowledgeBaseTextRef = useRef(knowledgeBaseText);
  const currentVoiceURIRef = useRef(currentVoiceURI);

  useEffect(() => { appStateRef.current = appState; }, [appState]);
  useEffect(() => { interactionStateRef.current = interactionState; }, [interactionState]);
  useEffect(() => { transcriptRef.current = transcript; }, [transcript]);
  useEffect(() => { knowledgeBaseTextRef.current = knowledgeBaseText; }, [knowledgeBaseText]);
  useEffect(() => { currentVoiceURIRef.current = currentVoiceURI; }, [currentVoiceURI]);

  const knowledgeFilesEnv = (import.meta as any).env.VITE_KNOWLEDGE_FILES || "";

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
               const text = await response.text();
               extractedText += text + '\n';
            }
        } catch (err) {
            console.error(`Failed to parse ${fileName}`, err);
        }
      }
      setKnowledgeBaseText(extractedText);
    };

    fetchKnowledgeBase();
  }, [knowledgeFilesEnv]);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcript, interactionState]);

  useEffect(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechRecognition) {
      recognitionRef.current = new SpeechRecognition();
      recognitionRef.current.continuous = true;
      recognitionRef.current.interimResults = true;
      recognitionRef.current.lang = 'en-US';

      recognitionRef.current.onresult = (event: any) => {
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          if (event.results[i].isFinal) {
            transcriptAccumulatorRef.current += event.results[i][0].transcript + " ";
            
            // Instantly finalize immediately on browser speech completion trigger (Zero artificial delay)
            const finalSpoken = transcriptAccumulatorRef.current.trim();
            if (finalSpoken.length > 0) {
              if (recognitionRef.current) try { recognitionRef.current.abort(); } catch(e){}
              handleUserSpeech(finalSpoken);
              transcriptAccumulatorRef.current = ""; 
            }
            return; // Immediately exit so we don't accumulate more interims while it aborts
          } else {
            interim += event.results[i][0].transcript;
          }
        }
      };

      recognitionRef.current.onerror = (event: any) => {
        if (event.error === 'not-allowed') setInteractionState('waiting');
      };

      recognitionRef.current.onend = () => {
        if (appStateRef.current === 'interviewing' && interactionStateRef.current === 'listening') {
          try { recognitionRef.current.start(); } catch (e) {}
        }
      };
    }

    return () => {
      cancelAudioPlayback();
      if (recognitionRef.current) try { recognitionRef.current.abort(); } catch(e){}
      if (speechTimerRef.current) clearTimeout(speechTimerRef.current);
    };
  }, []);

  const cancelAudioPlayback = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
  };

  const handleMainButtonTap = () => {
    if (appState === 'idle' || appState === 'completed') {
      startInterview();
    } else if (appState === 'interviewing') {
      if (interactionState === 'speaking' || interactionState === 'processing') {
         // Interruption capability
         cancelAudioPlayback();
         setInteractionState('listening');
         try { recognitionRef.current?.start(); } catch (e) {}
      } else {
         endInterview();
      }
    }
  };

  const startInterview = async () => {
    try {
       const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
       stream.getTracks().forEach(track => track.stop());
    } catch (err) {
       alert("Microphone permission was denied.");
       return;
    }

    if (!recognitionRef.current) {
      alert("Native browser dictation is explicitly blocked in your environment. Use Edge/Chrome natively.");
      return;
    }
    
    setAppState('interviewing');
    setTranscript([]);
    setEvaluation(null);
    transcriptAccumulatorRef.current = "";
    
    cancelAudioPlayback();
    setInteractionState('listening');
    try { recognitionRef.current.start(); } catch (e) {}
  };

  const handleUserSpeech = async (text: string) => {
    if (interactionStateRef.current === 'processing' || interactionStateRef.current === 'speaking') return;
    try { recognitionRef.current?.abort(); } catch (e) {}
    
    cancelAudioPlayback(); // Just in case it was lingering
    
    const isChangeSubject = text.toLowerCase().includes("replace participant");
    
    if (isChangeSubject) {
      const openAIVoices: TTSVoice[] = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
      const activeVoiceIndex = openAIVoices.indexOf(currentVoiceURIRef.current);
      const nextVoice = openAIVoices[(activeVoiceIndex + 1) % openAIVoices.length];
      setCurrentVoiceURI(nextVoice);
    }

    setInteractionState('processing');
    interactionStateRef.current = 'processing';
    const newTranscript: Message[] = [...transcriptRef.current, { speaker: 'user', text }];
    setTranscript(newTranscript);

    // AI Generation
    const responseText = await generateParticipantResponse(newTranscript, knowledgeBaseTextRef.current, isChangeSubject);
    
    // Check if interrupted DURING text generation
    if (appStateRef.current !== 'interviewing' || interactionStateRef.current !== 'processing') return;

    // Fetch Fluent TTS
    const audioUrl = await generateSpeech(responseText, currentVoiceURIRef.current);

    // Check if user forcefully interrupted DURING the high-quality TTS audio file download
    if (appStateRef.current !== 'interviewing' || interactionStateRef.current !== 'processing') return;

    if (audioUrl) {
      setInteractionState('speaking');
      
      // Delay displaying the text until the audio file has fully downloaded and is ready to play!
      setTranscript(prev => [...prev, { speaker: 'participant', text: responseText }]);
      
      const audio = new Audio(audioUrl);
      audioRef.current = audio;

      audio.onended = () => {
        if (appStateRef.current === 'interviewing' && interactionStateRef.current === 'speaking') {
          setInteractionState('listening');
          try { recognitionRef.current.start(); } catch (e) {}
        }
      };

      audio.onerror = () => {
        if (appStateRef.current === 'interviewing' && interactionStateRef.current === 'speaking') {
          setInteractionState('listening');
          try { recognitionRef.current.start(); } catch (e) {}
        }
      };

      audio.play().catch(console.error);
    } else {
      // Fallback if audio entirely failed to generate
      setInteractionState('listening');
      setTranscript(prev => [...prev, { speaker: 'participant', text: responseText }]);
      try { recognitionRef.current.start(); } catch (e) {}
    }
  };

  // speakResponse function removed as it was merged directly into handleUserSpeech

  const endInterview = async () => {
    setAppState('evaluating');
    setInteractionState('waiting');
    
    if (recognitionRef.current) try { recognitionRef.current.abort(); } catch(e){}
    if (speechTimerRef.current) clearTimeout(speechTimerRef.current);
    cancelAudioPlayback();
    
    // Catch any text they spoke right before hitting stop that hasn't finalized 
    const finalTranscript = [...transcriptRef.current];
    if (transcriptAccumulatorRef.current.trim().length > 0) {
      finalTranscript.push({ speaker: 'user', text: transcriptAccumulatorRef.current.trim() });
    }
    
    if (finalTranscript.length === 0) {
      setAppState('idle');
      return;
    }
    
    const result = await evaluateInterview(finalTranscript);
    setEvaluation(result);
    setAppState('completed');
  };

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col font-sans text-slate-200 relative overflow-hidden selection:bg-purple-500/30">
      <div className="absolute top-[-20%] left-[-10%] w-[500px] h-[500px] bg-purple-600/20 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute bottom-[-20%] right-[-10%] w-[500px] h-[500px] bg-blue-600/20 rounded-full blur-[120px] pointer-events-none" />

      <header className="px-6 py-5 flex items-center justify-center bg-slate-950/60 backdrop-blur-xl border-b border-white/5 sticky top-0 z-10 shadow-[0_10px_30px_-10px_rgba(0,0,0,0.5)]">
        <h1 className="text-sm font-bold bg-gradient-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent tracking-widest uppercase drop-shadow-sm">Participant Simulator</h1>
      </header>

      <main className="flex-1 w-full max-w-3xl mx-auto p-6 flex flex-col overflow-y-auto pb-48 z-10 scrollbar-hide">
        {appState === 'idle' && transcript.length === 0 && (
          <div className="flex-1 flex items-center justify-center text-slate-500 text-xl font-light">
            <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} className="flex flex-col items-center gap-6">
              <div className="w-20 h-20 rounded-full bg-gradient-to-br from-slate-800 to-slate-900 flex items-center justify-center border border-white/10 shadow-[0_0_30px_rgba(0,0,0,0.3)] inset-shadow-sm">
                <Mic className="text-slate-400" size={32} />
              </div>
              <p className="text-center tracking-wide text-base">Tap the button below to start.<br /><span className="text-xs opacity-70 mt-2 block">Say "Replace Participant" to switch persona</span></p>
            </motion.div>
          </div>
        )}

        {appState === 'evaluating' && (
          <div className="flex-1 flex flex-col items-center justify-center text-center">
            <Loader2 size={56} className="animate-spin text-purple-500 mb-6 drop-shadow-[0_0_15px_rgba(168,85,247,0.5)]" />
            <p className="text-slate-400 text-xl font-medium tracking-wide">Evaluating your interview...</p>
          </div>
        )}

        {transcript.length > 0 && (
          <div className="flex flex-col space-y-10 mt-4">
            {transcript.map((msg, idx) => (
              <motion.div initial={{ opacity: 0, y: 15, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} key={idx} className={`flex flex-col ${msg.speaker === 'user' ? 'items-end' : 'items-start'}`}>
                <span className={`text-[10px] font-bold uppercase tracking-widest mb-2 ${msg.speaker === 'user' ? 'text-blue-400' : 'text-purple-400'}`}>
                  {msg.speaker === 'user' ? 'You' : 'Participant'}
                </span>
                <p className={`text-2xl leading-relaxed font-light ${msg.speaker === 'user' ? 'text-slate-400 text-right' : 'text-slate-100 drop-shadow-sm'}`}>
                  {msg.text}
                </p>
              </motion.div>
            ))}
            
            {interactionState === 'processing' && (
               <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-start">
                 <span className="text-[10px] font-bold uppercase tracking-widest text-purple-400 mb-2">Participant Generating</span>
                 <div className="flex gap-2 mt-3 bg-slate-800/50 py-3 px-4 rounded-2xl border border-white/5 shadow-inner backdrop-blur-sm">
                   <motion.div animate={{ y: [0, -6, 0], opacity: [0.4, 1, 0.4] }} transition={{ repeat: Infinity, duration: 0.8, delay: 0 }} className="w-2.5 h-2.5 bg-purple-400 rounded-full shadow-[0_0_8px_rgba(192,132,252,0.6)]" />
                   <motion.div animate={{ y: [0, -6, 0], opacity: [0.4, 1, 0.4] }} transition={{ repeat: Infinity, duration: 0.8, delay: 0.2 }} className="w-2.5 h-2.5 bg-purple-400 rounded-full shadow-[0_0_8px_rgba(192,132,252,0.6)]" />
                   <motion.div animate={{ y: [0, -6, 0], opacity: [0.4, 1, 0.4] }} transition={{ repeat: Infinity, duration: 0.8, delay: 0.4 }} className="w-2.5 h-2.5 bg-purple-400 rounded-full shadow-[0_0_8px_rgba(192,132,252,0.6)]" />
                 </div>
               </motion.div>
            )}
          </div>
        )}

        {appState === 'completed' && evaluation && (
          <motion.div initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col items-center justify-center py-10 mt-10 border-t border-white/10">
            <div className="text-9xl font-black bg-gradient-to-br from-white to-slate-500 bg-clip-text text-transparent mb-2 tracking-tighter drop-shadow-lg">
              {evaluation.score}<span className="text-5xl text-slate-600">/10</span>
            </div>
            <h3 className="text-2xl font-bold text-slate-200 mb-8 flex items-center gap-3">
              <CheckCircle className="text-emerald-400 drop-shadow-[0_0_15px_rgba(52,211,153,0.4)]" size={32} /> 
              Evaluation Complete
            </h3>
            <div className="bg-slate-900/60 backdrop-blur-md rounded-3xl p-8 border border-white/10 w-full shadow-[0_20px_50px_-12px_rgba(0,0,0,0.8)] text-left flex flex-col gap-6">
              <div>
                 <h4 className="text-emerald-400 font-bold uppercase tracking-wider text-xs mb-3">Positive Feedback</h4>
                 <p className="text-slate-300 whitespace-pre-wrap leading-relaxed text-lg font-light">{String(evaluation.positiveFeedback).replace(/^"|"$/g, '')}</p>
              </div>
              
              {evaluation.constructiveFeedback && (
                <>
                  <div className="w-full h-px bg-white/10 block"></div>
                  <div>
                    <h4 className="text-amber-400 font-bold uppercase tracking-wider text-xs mb-3">Constructive Criticism</h4>
                    <p className="text-slate-300 whitespace-pre-wrap leading-relaxed text-lg font-light">{String(evaluation.constructiveFeedback).replace(/^"|"$/g, '')}</p>
                  </div>
                </>
              )}
            </div>
          </motion.div>
        )}
        <div ref={transcriptEndRef} className="h-10" />
      </main>

      {/* Toggles */}
      {(appState === 'idle' || appState === 'interviewing' || appState === 'completed') && (
        <div className="fixed bottom-12 left-1/2 -translate-x-1/2 flex flex-col items-center z-20">
          <button onClick={handleMainButtonTap} className={`relative w-24 h-24 rounded-full flex items-center justify-center shadow-2xl transition-all duration-300 outline-none group cursor-pointer
              ${appState === 'interviewing' ? 'bg-slate-900 border border-white/10 shadow-[0_0_30px_rgba(0,0,0,0.5)]' : 'bg-gradient-to-br from-blue-600 to-purple-600 hover:scale-110 hover:shadow-[0_0_40px_rgba(168,85,247,0.5)]'}`}>
            
            {/* Listening State Ring */}
            {appState === 'interviewing' && interactionState === 'listening' && (
              <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 3, ease: "linear" }} className="absolute inset-[-4px] rounded-full border-[3px] border-transparent border-t-blue-400 border-r-blue-400" />
            )}

            {/* Speaking State Ring - Interruptible! */}
            {interactionState === 'speaking' && (
               <motion.div animate={{ rotate: -360 }} transition={{ repeat: Infinity, duration: 1.5, ease: "linear" }} className="absolute inset-[-4px] rounded-full border-[3px] border-transparent border-t-purple-500 border-b-purple-500" />
            )}

            {interactionState === 'speaking' ? (
               <Square size={28} fill="currentColor" className="text-purple-400 drop-shadow-[0_0_8px_rgba(168,85,247,0.6)] group-hover:scale-95 transition-transform" />
            ) : appState === 'interviewing' ? (
              <Square size={28} fill="currentColor" className="text-red-400 drop-shadow-[0_0_8px_rgba(248,113,113,0.6)] group-hover:scale-95 transition-transform" />
            ) : (
              <Mic size={36} className="text-white drop-shadow-[0_2px_4px_rgba(0,0,0,0.4)] group-hover:scale-110 transition-transform" />
            )}
          </button>
          <span className="mt-6 text-[10px] font-bold tracking-widest uppercase text-slate-500 drop-shadow-sm text-center">
            {appState === 'idle' || appState === 'completed' ? 'Tap to Start' : interactionState === 'speaking' ? 'Tap to Interrupt' : 'Tap to Stop'}
          </span>
        </div>
      )}
    </div>
  );
}
