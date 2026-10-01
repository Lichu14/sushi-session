import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import { MerchantVisitsService } from './merchant-visits.service.js';

@Controller('merchant')
export class MerchantController {
  constructor(private readonly visits: MerchantVisitsService) {}

  @Get('locations')
  @Header('Cache-Control', 'no-store')
  locations(@CurrentUser() user: AuthenticatedUser, @Query() query: unknown) {
    return this.visits.locations(user.id, query);
  }

  @Get('visits')
  @Header('Cache-Control', 'no-store')
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: unknown) {
    return this.visits.list(user.id, query);
  }

  @Post('visits/:visitId/verify')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  verify(
    @CurrentUser() user: AuthenticatedUser,
    @Param('visitId') visitId: string,
    @Body() body: unknown,
  ) {
    return this.visits.verify(user.id, visitId, body);
  }

  @Post('visits/:visitId/reject')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  reject(
    @CurrentUser() user: AuthenticatedUser,
    @Param('visitId') visitId: string,
    @Body() body: unknown,
  ) {
    return this.visits.reject(user.id, visitId, body);
  }
}
