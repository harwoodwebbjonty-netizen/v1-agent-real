import anthropic

from app.core.config import get_settings
from app.schemas_chat import ChatTurn

# Read-only by construction: this module has no write/side-effect calls at
# all, doesn't import anything from the lookup pipeline, and the system
# prompt explicitly forbids the model from claiming to take any action.

SYSTEM_PROMPT = (
    "You are a read-only sales assistant answering questions about ONE lead. "
    "You can only use the lead context provided below — you have no tools, "
    "cannot browse the web, cannot send emails, and cannot modify any data. "
    "If asked to do something other than answer a question (e.g. 'send an "
    "email', 'update the status'), explain that you can only provide "
    "information and suggestions, not take actions. Be concise and practical."
)


async def chat_about_lead(context: str, message: str, history: list[ChatTurn]) -> str:
    settings = get_settings()
    client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)

    messages = [{"role": "user", "content": f"Lead context (JSON):\n{context}"}]
    messages.append({"role": "assistant", "content": "Understood. Ask me anything about this lead."})
    for turn in history:
        messages.append({"role": turn.role, "content": turn.content})
    messages.append({"role": "user", "content": message})

    response = await client.messages.create(
        model=settings.model,
        max_tokens=1024,
        system=SYSTEM_PROMPT,
        messages=messages,
    )

    return "\n".join(block.text for block in response.content if block.type == "text")
