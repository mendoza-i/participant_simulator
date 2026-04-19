import OpenAI from 'openai';

// We are using the OpenAI API as the "sample API" so you can test the app immediately.
// You can later replace this with your own custom API.
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, dangerouslyAllowBrowser: true });

export type Message = { speaker: 'user' | 'participant'; text: string };

export type EvaluationResult = {
  score: number;
  positiveFeedback: string;
  constructiveFeedback: string;
};

export type TTSVoice = 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer';

export async function transcribeAudio(audioBlob: Blob): Promise<string> {
  try {
    // Determine file extension from blob mime type for Whisper compatibility
    const mimeType = audioBlob.type || 'audio/webm';
    let ext = 'webm';
    if (mimeType.includes('mp4') || mimeType.includes('m4a')) ext = 'mp4';
    else if (mimeType.includes('ogg')) ext = 'ogg';
    else if (mimeType.includes('wav')) ext = 'wav';

    const file = new File([audioBlob], `audio.${ext}`, { type: mimeType });

    const response = await openai.audio.transcriptions.create({
      model: 'whisper-1',
      file: file,
      language: 'en',
    });

    return response.text.trim();
  } catch (error) {
    console.error('Error transcribing audio:', error);
    return '';
  }
}

export async function generateSpeech(text: string, voice: TTSVoice = 'alloy'): Promise<string | null> {
  try {
    const response = await openai.audio.speech.create({
      model: "tts-1",
      voice: voice,
      input: text,
    });
    
    // Convert to playable blob URL in the browser
    const buffer = await response.arrayBuffer();
    const blob = new Blob([buffer], { type: 'audio/mpeg' });
    return URL.createObjectURL(blob);
  } catch (error) {
    console.error("Error generating speech:", error);
    return null;
  }
}

export async function generateParticipantResponse(transcript: Message[], knowledgeBaseText: string = "", personaOverride: boolean = false): Promise<string> {
  try {
    let systemInstruction = "You are participating in an interview. Keep your answers conversational, concise (1 to 3 sentences max), and spoken directly in the first person. Do not break character. Do not ask the interviewer what persona they want. ";
    
    if (personaOverride) {
      systemInstruction += `\nCRITICAL DIRECTIVE: The user has commanded you to 'Replace Participant'. You MUST immediately abandon your current persona. Look through the KNOWLEDGE BASE below, pick a completely different specific persona/subject from the text, and begin answering as them. Introduce yourself subtly as the new persona. Keep it natural!`;
    } else {
      systemInstruction += `\nAssume a distinct persona based on the KNOWLEDGE BASE provided. Stick to it.`;
    }

    if (knowledgeBaseText.trim().length > 0) {
      systemInstruction += `\n\n--- KNOWLEDGE BASE ---\nAct strictly using the details found within the following documents. Never hallucinate details outside of this context. If the interviewer strays away from the topic or asks completely unrelated questions, act like a real person: grow slightly impatient, refuse to answer the irrelevant question, and firmly demand to know why they are straying from the topic. Do NOT be overly helpful outside of your specific context.\n${knowledgeBaseText}`;
    }

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemInstruction },
      ...transcript.map(t => ({
        role: t.speaker === 'user' ? 'user' : 'assistant',
        content: t.text
      } as OpenAI.Chat.ChatCompletionMessageParam))
    ];
    
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: messages,
      temperature: 0.8
    });
    
    return response.choices[0].message.content || "I'm not sure how to answer that.";
  } catch (error) {
    console.error("Error generating response:", error);
    return "Sorry, I didn't catch that. Could you repeat?";
  }
}

export async function evaluateInterview(transcript: Message[]): Promise<EvaluationResult> {
  try {
    const prompt = `Review the following interview transcript where a user is interviewing a Medical Technologist who transitioned to Nuclear Medicine.
Evaluate the interviewer's performance. Consider:
1. Relevance of questions to the MedTech to Nuclear Medicine transition.
2. Flow of the conversation and follow-up questions.
3. Professionalism.

Provide a JSON response with:
- "score": A number out of 10.
- "positiveFeedback": Direct, specific positive notes for the interviewer based on their questions.
- "constructiveFeedback": Direct, specific areas the interviewer can improve upon.

Transcript:
${transcript.map(t => `${t.speaker === 'user' ? 'Interviewer' : 'Participant'}: ${t.text}`).join('\n')}`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are an evaluator. Always return structured JSON.' },
        { role: 'user', content: prompt }
      ],
      response_format: { type: 'json_object' }
    });
    
    const result = JSON.parse(response.choices[0].message.content || '{}');
    
    let safePositive = "No positive notes provided.";
    if (result.positiveFeedback) safePositive = typeof result.positiveFeedback === 'string' ? result.positiveFeedback : JSON.stringify(result.positiveFeedback);
    
    let safeConstructive = "No constructive notes provided.";
    if (result.constructiveFeedback) safeConstructive = typeof result.constructiveFeedback === 'string' ? result.constructiveFeedback : JSON.stringify(result.constructiveFeedback);
    
    return {
      score: typeof result.score === 'number' ? result.score : parseInt(result.score) || 0,
      positiveFeedback: safePositive,
      constructiveFeedback: safeConstructive
    };
  } catch (error) {
    console.error("Error evaluating interview:", error);
    return {
      score: 0,
      positiveFeedback: "Failed to generate evaluation due to an error.",
      constructiveFeedback: ""
    };
  }
}
