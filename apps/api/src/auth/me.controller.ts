import { Controller, Get, Header } from '@nestjs/common';
import { CurrentUser } from './current-user.decorator.js';
import type { AuthenticatedUser } from './auth.types.js';

@Controller('me')
export class MeController {
  @Get()
  @Header('Cache-Control', 'no-store')
  getMe(@CurrentUser() user: AuthenticatedUser) {
    return user.profile;
  }
}
