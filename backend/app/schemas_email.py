from pydantic import BaseModel


class EmailScrapeResult(BaseModel):
    emails: list[str]
    confidence_note: str
