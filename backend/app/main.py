from fastapi import Depends, FastAPI, Request
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
from starlette.responses import JSONResponse

from app.core.config import get_settings
from app.core.rate_limit import limiter
from app.dependencies import CurrentUser, get_current_user
from app.schemas import LookupRequest, LookupResult
from app.services import usage_log
from app.services.anthropic_service import lookup_company_phone

app = FastAPI(title="Company Phone Lookup Backend")
app.state.limiter = limiter
app.add_middleware(SlowAPIMiddleware)


@app.exception_handler(RateLimitExceeded)
async def rate_limit_handler(request: Request, exc: RateLimitExceeded) -> JSONResponse:
    return JSONResponse(status_code=429, content={"detail": "Rate limit exceeded. Try again shortly."})


@app.post("/lookup-company-phone", response_model=LookupResult)
@limiter.limit(get_settings().rate_limit)
async def lookup_company_phone_route(
    request: Request,
    body: LookupRequest,
    current_user: CurrentUser = Depends(get_current_user),
) -> LookupResult:
    result = await lookup_company_phone(body.company)
    usage_log.record_usage(
        user_id=current_user.id,
        company=body.company,
        status=result.status,
        success=result.status != "not_found",
    )
    return result
