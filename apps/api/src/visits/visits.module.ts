import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { CheckInService } from './check-in.service.js';
import { SushiSessionService } from './sushi-session.service.js';
import { VisitsController } from './visits.controller.js';

@Module({
  imports: [PrismaModule],
  controllers: [VisitsController],
  providers: [CheckInService, SushiSessionService],
  exports: [CheckInService, SushiSessionService],
})
export class VisitsModule {}
