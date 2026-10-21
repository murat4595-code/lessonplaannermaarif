// Maarif Lesson Planner - server-side lesson plan generation through the
// OpenRouter API, restricted to free models. The API key lives in the Netlify
// environment variable OPENROUTER_API_KEY and never reaches the browser. The
// browser sends only the form selections; both prompts are assembled here, so
// the curricular directives cannot be altered from the client.

// Free models only, tried in order until one accepts the request (free models
// are often rate-limited). Each has the reasoning setting it supports: Gemma
// runs without reasoning; MiniMax requires it, so it is kept low and hidden.
// "openrouter/free" selects among free models only.
const FREE_MODELS = [
    { model: "google/gemma-4-31b-it:free", reasoning: { enabled: false } },
    { model: "minimax/minimax-m3.1-flash:free", reasoning: { effort: "low", exclude: true } },
    { model: "openrouter/free", reasoning: { effort: "low", exclude: true } },
];
const MAX_TOKENS = 8000;

const SYSTEM_PROMPT = `
You are an expert English curriculum designer specializing in the Türkiye Yüzyılı Maarif Modeli (Century of Türkiye Education Model) for Grades 9-12.
Your task is to generate structured, pedagogically sound lesson plans that are strictly aligned with this new model.

**CORE PHILOSOPHY (Must Integrate):**
1. **Erdem-Değer-Eylem (Virtue-Value-Action) Framework:** Every lesson must integrate a core value (e.g., Justice, Friendship, Respect, Patriotism) implicitly or explicitly.
2. **Holistic Approach:** Focus on Conceptual Skills (Kavramsal Beceriler), Social-Emotional Skills (Sosyal-Duygusal Beceriler), and Literacy Skills (Okuryazarlık Becerileri).
3. **Communicative & Action-Oriented:** Language is a tool for communication, not just a set of rules.

The model must return a complete lesson plan in the following structure:
# Generated Lesson Plan
## 1. Lesson Title
## 2. Grade Level & Duration
## 3. Outcomes (Maarif Modeli)
## 4. Core Values & Skills (Erdem-Değer-Eylem)
*Specify the values and social-emotional skills targeted in this lesson.*
## 5. Lesson Objectives
## 6. Materials
## 7. Warm-up (5 minutes)
## 8. Presentation Phase
## 9. Practice Phase
## 10. Production Phase (Action-Oriented Task)
## 11. Differentiation Strategies
## 12. Assessment (Process-Oriented)
IMPORTANT: If providing a Rubric or Checklist, YOU MUST format it as a MARKDOWN TABLE.
## 13. Homework / Extension
## 14. Reflection Section for the Teacher
## 15. Listening Transcript (REQUIRED IF LISTENING IS INVOLVED)

Additional Rules:
* Vocabulary: Include high-frequency words appropriate for the theme.
* Grammar: Teach grammar in context, not in isolation.
* Content: Ensure cultural relevance to Türkiye while maintaining a global perspective.
* Output only the lesson plan in the structure above, starting with "# Generated Lesson Plan".
`.trim();

const FIELDS = ["gradeLevel", "outcomes", "topic", "targetLanguage", "duration", "studentProfile", "activityTypes", "assessmentType"];
const MAX_FIELD_LENGTH = 300;

// Accept only values shaped like the tool's own drop-down options, so the
// endpoint cannot be used as a general-purpose proxy to the model.
function validate(data) {
    if (!data || typeof data !== "object") return "Invalid request body.";
    for (const f of FIELDS) {
        if (typeof data[f] !== "string" || !data[f].trim() || data[f].length > MAX_FIELD_LENGTH) return `Invalid field: ${f}`;
    }
    if (!["9", "10", "11", "12"].includes(data.gradeLevel)) return "Invalid grade level.";
    if (!/^\[Theme \d+\] ENG\.\d{1,2}\.\d+\.[A-Z]+\d+\./.test(data.outcomes)) return "Invalid outcome.";
    if (!/^Theme \d+:/.test(data.topic)) return "Invalid theme.";
    if (!/^(40|80|120) minutes/.test(data.duration)) return "Invalid duration.";
    return null;
}

function buildUserPrompt(data) {
    return `Create lesson plan.

1. Grade: ${data.gradeLevel}
2. Outcomes: ${data.outcomes}
3. Topic: ${data.topic}
4. Language Target: ${data.targetLanguage}
5. Time: ${data.duration}
6. Profile: ${data.studentProfile}
7. Activities: ${data.activityTypes}
8. Assessment: ${data.assessmentType}

**SPECIFIC INSTRUCTIONS FOR GRADES 9-12:**
- Use the exact vocabulary and grammar specified for the selected Theme in the official Maarif Model curriculum.
- Ensure the "Erdem-Değer-Eylem" (Virtue-Value-Action) framework is integrated.
- Focus on the sub-themes provided in the input (e.g., if Theme 1 is selected, focus on "Students of different countries", etc.).`;
}

// Browsers may call the function from the GitHub Pages copy of the interface.
const ALLOWED_ORIGINS = ["https://murat4595-code.github.io", "https://maariflessonplanner.netlify.app"];

function corsHeaders(req) {
    const origin = req.headers.get("origin");
    if (!origin || !ALLOWED_ORIGINS.includes(origin)) return {};
    return {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
        "Vary": "Origin",
    };
}

export default async (req) => {
    const cors = corsHeaders(req);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const res = await handle(req);
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
};

async function handle(req) {
    let data;
    try {
        data = await req.json();
    } catch {
        return Response.json({ error: "Invalid JSON." }, { status: 400 });
    }
    const problem = validate(data);
    if (problem) return Response.json({ error: problem }, { status: 400 });

    const apiKey = (process.env.OPENROUTER_API_KEY || "").trim();
    if (!apiKey) {
        console.error("OPENROUTER_API_KEY is not set.");
        return Response.json({ error: "Server configuration error: the AI service is not configured." }, { status: 500 });
    }

    let upstream;
    for (const { model, reasoning } of FREE_MODELS) {
        upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
                "HTTP-Referer": "https://maariflessonplanner.netlify.app",
                "X-Title": "Maarif Lesson Planner",
            },
            body: JSON.stringify({
                model,
                reasoning,
                stream: true,
                temperature: 0.7,
                max_tokens: MAX_TOKENS,
                messages: [
                    { role: "system", content: SYSTEM_PROMPT },
                    { role: "user", content: buildUserPrompt(data) },
                ],
            }),
        });
        if (upstream.ok && upstream.body) break;
        // Authentication and credit problems are not model-specific; stop trying.
        if ([401, 402, 403].includes(upstream.status)) break;
        console.warn(`Model ${model} unavailable (${upstream.status}); trying the next free model.`);
    }

    if (!upstream.ok || !upstream.body) {
        const detail = await upstream.text().catch(() => "");
        console.error("OpenRouter API error:", upstream.status, detail.slice(0, 500));
        const note = upstream.status === 429 ? "The service is busy. Please wait a minute and try again."
            : upstream.status === 401 || upstream.status === 403 ? "Server configuration error: the API key is missing or invalid."
            : upstream.status === 402 ? "The AI service account has run out of credits."
            : `AI service error (${upstream.status}). Please try again.`;
        return Response.json({ error: note }, { status: 502 });
    }

    // Re-stream the server-sent events as plain text so the teacher sees the
    // plan being written and the request stays inside the function time limit.
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const body = new ReadableStream({
        async start(controller) {
            const reader = upstream.body.getReader();
            let buffer = "", finish = "";
            try {
                for (;;) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    let nl;
                    while ((nl = buffer.indexOf("\n")) >= 0) {
                        const line = buffer.slice(0, nl).trim();
                        buffer = buffer.slice(nl + 1);
                        if (!line.startsWith("data:")) continue; // skips ": OPENROUTER PROCESSING" keep-alives
                        const payload = line.slice(5).trim();
                        if (payload === "[DONE]") continue;
                        const chunk = JSON.parse(payload);
                        if (chunk.error) throw new Error(chunk.error.message || "upstream error");
                        const choice = chunk.choices?.[0];
                        const text = choice?.delta?.content || "";
                        if (text) controller.enqueue(encoder.encode(text));
                        if (choice?.finish_reason) finish = choice.finish_reason;
                    }
                }
                if (finish === "length") {
                    controller.enqueue(encoder.encode("\n\n[The lesson plan reached the length limit and may be incomplete.]"));
                } else if (finish && finish !== "stop") {
                    controller.enqueue(encoder.encode("\n\n[The model stopped before completing this lesson plan. Please adjust the selections and try again.]"));
                }
            } catch (error) {
                console.error("Stream error:", error);
                controller.enqueue(encoder.encode("\n\n[ERROR] Unexpected error while generating the lesson plan."));
            } finally {
                controller.close();
            }
        },
    });

    return new Response(body, {
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
}

export const config = {
    path: "/api/generate",
    method: ["POST", "OPTIONS"],
};
