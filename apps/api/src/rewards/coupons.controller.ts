import { Controller, Get, Header, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import { CouponsService } from './coupons.service.js';

@Controller('me/coupons')
export class CouponsController {
  constructor(private readonly coupons: CouponsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: unknown) {
    return this.coupons.list(user.id, query);
  }
}
