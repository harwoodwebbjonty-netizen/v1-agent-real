from typing import List

from pydantic import BaseModel


class ChatTurn(BaseModel):
    role: str
    content: str


class LeadChatRequest(BaseModel):
    context: str
    message: str
    history: List[ChatTurn] = []


class LeadChatResponse(BaseModel):
    reply: str
