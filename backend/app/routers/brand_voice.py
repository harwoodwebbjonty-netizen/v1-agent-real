from fastapi import APIRouter, Depends

from app import db
from app.dependencies import CurrentUser, get_current_user
from app.schemas_brand_voice import BrandVoiceOut, UpdateBrandVoiceRequest
from app.services.auth_service import now_iso

router = APIRouter(prefix="/brand-voice", tags=["brand-voice"])


def _to_brand_voice_out(row) -> BrandVoiceOut:
    if row is None:
        return BrandVoiceOut(
            company_name="",
            company_description="",
            industry="",
            target_audience="",
            core_services="",
            unique_selling_points="",
            preferred_writing_style="",
            preferred_cta_style="",
            preferred_email_length="",
            website="",
            booking_link="",
            signature="",
        )
    return BrandVoiceOut(
        company_name=row["company_name"],
        company_description=row["company_description"],
        industry=row["industry"],
        target_audience=row["target_audience"],
        core_services=row["core_services"],
        unique_selling_points=row["unique_selling_points"],
        preferred_writing_style=row["preferred_writing_style"],
        preferred_cta_style=row["preferred_cta_style"],
        preferred_email_length=row["preferred_email_length"],
        website=row["website"],
        booking_link=row["booking_link"],
        signature=row["signature"],
    )


@router.get("", response_model=BrandVoiceOut)
def get_brand_voice(current_user: CurrentUser = Depends(get_current_user)) -> BrandVoiceOut:
    return _to_brand_voice_out(db.get_brand_voice(current_user.id))


@router.put("", response_model=BrandVoiceOut)
def update_brand_voice(
    body: UpdateBrandVoiceRequest, current_user: CurrentUser = Depends(get_current_user)
) -> BrandVoiceOut:
    db.upsert_brand_voice(current_user.id, body.model_dump(), now_iso())
    return _to_brand_voice_out(db.get_brand_voice(current_user.id))
