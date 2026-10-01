import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import { CheckInService } from './check-in.service.js';
import { SushiSessionService } from './sushi-session.service.js';
import { historyInput } from './inputs.js';

// AuthModule's global AuthGuard validates every route; none are marked Public.
@Controller()
export class VisitsController {
  constructor(
    private readonly checkIns: CheckInService,
    private readonly sessions: SushiSessionService,
  ) {}

  @Post('check-ins')
  @Header('Cache-Control', 'no-store')
  checkIn(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.checkIns.checkIn(user.id, body);
  }

  @Post('visits/:visitId/session')
  @Header('Cache-Control', 'no-store')
  start(
    @CurrentUser() user: AuthenticatedUser,
    @Param('visitId') id: string,
    @Body() body: unknown,
  ) {
    return this.sessions.start(user.id, id, body);
  }

  @Patch('sessions/:sessionId')
  @Header('Cache-Control', 'no-store')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('sessionId') id: string,
    @Body() body: unknown,
  ) {
    return this.sessions.update(user.id, id, body);
  }

  @Post('sessions/:sessionId/complete')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  complete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('sessionId') id: string,
    @Body() body: unknown,
  ) {
    return this.sessions.complete(user.id, id, body);
  }

  @Get('me/visits')
  @Header('Cache-Control', 'no-store')
  visits(@CurrentUser() user: AuthenticatedUser, @Query() query: unknown) {
    return this.checkIns.history(user.id, historyInput(query));
  }

  @Get('me/sessions')
  @Header('Cache-Control', 'no-store')
  history(@CurrentUser() user: AuthenticatedUser, @Query() query: unknown) {
    return this.sessions.history(user.id, historyInput(query));
  }
}
