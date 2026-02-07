import { Module } from '@nestjs/common';
import { AlertsController } from './alerts.controller';
import { AlertsService } from './alerts.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [AlertsController],
  providers: [AlertsService],
  exports: [AlertsService], // Export so other modules can use it
})
export class AlertsModule {}
