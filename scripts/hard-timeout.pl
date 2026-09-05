#!/usr/bin/env perl
use strict;
use warnings;
use POSIX qw(WNOHANG setsid);
use Time::HiRes qw(time sleep);

my ($timeout_seconds, $kill_grace_seconds, @command) = @ARGV;
die "usage: hard-timeout.pl TIMEOUT_SECONDS KILL_GRACE_SECONDS COMMAND [ARG...]\n"
  unless defined $timeout_seconds
    && defined $kill_grace_seconds
    && $timeout_seconds =~ /^[1-9][0-9]*$/
    && $kill_grace_seconds =~ /^[1-9][0-9]*$/
    && @command;

pipe(my $ready_reader, my $ready_writer) or die "cannot create readiness pipe: $!\n";
my $child_pid = fork();
die "cannot fork timeout child: $!\n" unless defined $child_pid;

if ($child_pid == 0) {
  close $ready_reader;
  setsid() != -1 or die "cannot create timeout process group: $!\n";
  syswrite($ready_writer, '1') == 1 or die "cannot signal timeout readiness: $!\n";
  close $ready_writer;
  exec @command;
  die "cannot start command: $!\n";
}

close $ready_writer;
my $ready = '';
read($ready_reader, $ready, 1);
close $ready_reader;

my $deadline = time() + $timeout_seconds;
my $kill_deadline = 0;
my $timed_out = 0;
my $kill_sent = 0;
my $child_exited = 0;
my $status;

sub stop_child_group {
  kill 'TERM', -$child_pid;
  sleep 0.05;
  kill 'KILL', -$child_pid;
}

$SIG{INT} = sub { stop_child_group(); exit 130; };
$SIG{TERM} = sub { stop_child_group(); exit 143; };
$SIG{HUP} = sub { stop_child_group(); exit 129; };

while (1) {
  if (!$child_exited) {
    my $waited = waitpid($child_pid, WNOHANG);
    if ($waited == $child_pid) {
      $status = $?;
      $child_exited = 1;
    } elsif ($waited == -1) {
      die "cannot wait for timeout child: $!\n";
    }
  }

  my $now = time();
  if (!$timed_out && $child_exited) {
    last;
  } elsif (!$timed_out && $now >= $deadline) {
    kill 'TERM', -$child_pid;
    $timed_out = 1;
    $kill_deadline = $now + $kill_grace_seconds;
  } elsif ($timed_out && !$kill_sent && $now >= $kill_deadline) {
    kill 'KILL', -$child_pid;
    $kill_sent = 1;
    last;
  }
  sleep 0.05;
}

exit 124 if $timed_out;
exit($status >> 8) if ($status & 127) == 0;
exit 128 + ($status & 127);
