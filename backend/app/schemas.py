from typing import Literal

from pydantic import BaseModel


class LookupRequest(BaseModel):
    company: str


class LookupResult(BaseModel):
    company: str
    phone_number: str
    source_url: str
    status: Literal["verified", "unverified", "not_found"]
    notes: str
