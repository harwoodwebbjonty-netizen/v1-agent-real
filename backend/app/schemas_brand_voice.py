from pydantic import BaseModel


class BrandVoiceOut(BaseModel):
    company_name: str
    company_description: str
    industry: str
    target_audience: str
    core_services: str
    unique_selling_points: str
    preferred_writing_style: str
    preferred_cta_style: str
    preferred_email_length: str
    website: str
    booking_link: str
    signature: str


class UpdateBrandVoiceRequest(BaseModel):
    company_name: str = ""
    company_description: str = ""
    industry: str = ""
    target_audience: str = ""
    core_services: str = ""
    unique_selling_points: str = ""
    preferred_writing_style: str = ""
    preferred_cta_style: str = ""
    preferred_email_length: str = ""
    website: str = ""
    booking_link: str = ""
    signature: str = ""
